import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLifecycleBaseline, validateLifecycleBaselineSet } from '../lib/governance/lifecycleBaseline.mjs';

const now = '2026-10-14T18:00:00.000Z';
const trust = [{ system: 'fixture-lifecycle-authority', component: 'baseline-export', domain: 'BACKEND_LOGICAL', provenanceKinds: ['SIGNED_EXPORT'] }];
const baseline = (overrides = {}) => ({
  schemaVersion: '1.0', cpsId: 'cpslai1', plugEventId: 'plug-1', plugCycleId: 'cycle-1', profileId: 'profile-1',
  lifecycleState: 'play', governanceStatus: 'APPROVED',
  source: { system: 'fixture-lifecycle-authority', component: 'baseline-export', recordId: 'source-record-1', domain: 'BACKEND_LOGICAL' },
  observedAt: '2026-10-14T17:59:00.000Z', verifiedAt: '2026-10-14T17:59:30.000Z',
  provenance: { kind: 'SIGNED_EXPORT', issuer: 'fixture-verifier', verificationId: 'verification-1' },
  evidenceReference: { recordId: 'source-record-1', sha256: 'a'.repeat(64) },
  confirmationLevel: 'BACKEND_ACCEPTED', ...overrides,
});
const governance = (overrides = {}) => ({
  cpsId: 'cpslai1', plugEventId: 'plug-1', plugCycleId: 'cycle-1', profileId: 'profile-1',
  cycleState: 'ACTIVE', profilePlugCycleStatus: 'ACTIVE', governanceStatus: 'APPROVED', ...overrides,
});
const verifyProvenance = (candidate) => ({
  verified: true, verificationId: candidate.provenance.verificationId,
  system: candidate.source.system, component: candidate.source.component,
  contentHash: candidate.evidenceReference.sha256,
});
const validate = (candidate = baseline(), expected = governance(), options = {}) => validateLifecycleBaseline(candidate, {
  expectedCpsId: 'cpslai1', governance: expected, trustedSources: trust, verifyProvenance, now, maxAgeMs: 120_000, ...options,
});

test('accepts a complete, fresh, correlated backend-logical baseline under explicit source policy', () => {
  assert.equal(validate().status, 'PASS');
});

test('missing evidence, provenance or freshness policy remains BLOCKED', () => {
  assert.equal(validate(null).status, 'BLOCKED');
  assert.equal(validate(baseline({ evidenceReference: null })).code, 'LIFECYCLE_BASELINE_EVIDENCE_REFERENCE_MISSING');
  assert.equal(validate(baseline({ provenance: null })).code, 'LIFECYCLE_BASELINE_PROVENANCE_MISSING');
  assert.equal(validate(baseline(), governance(), { maxAgeMs: undefined }).status, 'BLOCKED');
  assert.equal(validate(baseline(), governance(), { verifyProvenance: undefined }).code, 'LIFECYCLE_BASELINE_PROVENANCE_VERIFIER_MISSING');
  assert.equal(validate(baseline(), governance(), { verifyProvenance: () => ({ verified: false }) }).status, 'BLOCKED');
});

test('rejects divergent CPS/cycle/profile/governance identity and inconsistent lifecycle state', () => {
  assert.equal(validate(baseline({ plugCycleId: 'other-cycle' })).status, 'FAIL');
  assert.equal(validate(baseline(), governance({ profileId: 'old-profile' })).code, 'LIFECYCLE_BASELINE_GOVERNANCE_IDENTITY_CONFLICT');
  assert.equal(validate(baseline({ lifecycleState: 'unplugged' })).code, 'LIFECYCLE_BASELINE_ACTIVE_STATE_CONFLICT');
  assert.equal(validate(baseline(), governance({ cycleState: 'CLOSED' })).code, 'LIFECYCLE_BASELINE_CYCLE_NOT_ACTIVE');
});

test('stale observation and untrusted or mismatched confirmation source do not pass', () => {
  assert.equal(validate(baseline({ observedAt: '2026-10-14T17:00:00.000Z', verifiedAt: '2026-10-14T17:00:01.000Z' })).code, 'LIFECYCLE_BASELINE_STALE');
  assert.equal(validate(baseline({ source: { ...baseline().source, system: 'untrusted' } })).status, 'BLOCKED');
  assert.equal(validate(baseline({ confirmationLevel: 'PHYSICAL_STATE_CONFIRMED' })).code, 'LIFECYCLE_BASELINE_CONFIRMATION_DOMAIN_CONFLICT');
});

test('timestamps must be canonical, ordered and not future dated', () => {
  assert.equal(validate(baseline({ verifiedAt: '2026-10-14T17:58:00.000Z' })).code, 'LIFECYCLE_BASELINE_TIMESTAMP_INVALID');
  assert.equal(validate(baseline({ verifiedAt: '2026-10-14T18:01:00.000Z' })).code, 'LIFECYCLE_BASELINE_VERIFIED_IN_FUTURE');
});

test('set validation blocks absent CPS and fails duplicate active cycle or event identities', () => {
  const rows = ['cpslai1', 'cpslai2', 'cpslai3'].map((cpsId, index) => ({ ...baseline({ cpsId, plugEventId: `plug-${index}`, plugCycleId: `cycle-${index}`, profileId: `profile-${index}` }), source: baseline().source, provenance: baseline().provenance }));
  const govRows = rows.map((row) => governance({ ...row, governanceStatus: 'APPROVED' }));
  const baselinePolicy = { trustedSources: trust, verifyProvenance, now, maxAgeMs: 120_000 };
  assert.equal(validateLifecycleBaselineSet({ baselines: rows.slice(0, 2), governanceRows: govRows.slice(0, 2), ...baselinePolicy }).find((item) => item.cpsId === 'cpslai3').status, 'BLOCKED');
  const duplicate = validateLifecycleBaselineSet({ baselines: [rows[0], { ...rows[1], plugCycleId: rows[0].plugCycleId }], governanceRows: govRows.slice(0, 2), expectedCpsIds: ['cpslai1', 'cpslai2'], ...baselinePolicy });
  assert.deepEqual(duplicate.map((item) => item.status), ['FAIL', 'FAIL']);
  const multi = validateLifecycleBaselineSet({ baselines: [rows[0]], governanceRows: [govRows[0], govRows[0]], expectedCpsIds: ['cpslai1'], ...baselinePolicy });
  assert.equal(multi[0].code, 'LIFECYCLE_BASELINE_MULTIPLE_ACTIVE_CYCLES');
});

test('serialized baseline can be revalidated after process-style reconstruction without mutation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-lifecycle-baseline-'));
  try {
    const file = path.join(directory, 'baseline-fixture.json');
    fs.writeFileSync(file, JSON.stringify(baseline()));
    const before = fs.readFileSync(file, 'utf8');
    const reconstructed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(validate(reconstructed).status, 'PASS');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('physical confirmation is accepted only from an explicitly trusted physical source; no level is inferred', () => {
  const physicalTrust = [{ system: 'fixture-sensor-authority', component: 'observation-export', domain: 'PHYSICAL', provenanceKinds: ['SIGNED_OBSERVATION'] }];
  const physical = baseline({
    source: { system: 'fixture-sensor-authority', component: 'observation-export', recordId: 'observation-1', domain: 'PHYSICAL' },
    provenance: { kind: 'SIGNED_OBSERVATION', issuer: 'fixture-verifier', verificationId: 'verification-2' },
    evidenceReference: { recordId: 'observation-1', sha256: 'b'.repeat(64) },
    confirmationLevel: 'PHYSICAL_STATE_CONFIRMED',
  });
  assert.equal(validateLifecycleBaseline(physical, { expectedCpsId: 'cpslai1', governance: governance(), trustedSources: physicalTrust, verifyProvenance, now, maxAgeMs: 120_000 }).status, 'PASS');
  assert.equal(validate(physical).status, 'BLOCKED');
});
