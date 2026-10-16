const CPS_LAI_IDS = Object.freeze(['cpslai1', 'cpslai2', 'cpslai3']);
const STATES = new Set(['idle', 'plug', 'play', 'unplug', 'unplugged']);
const GOVERNANCE = new Set(['PENDING_APPROVAL', 'APPROVED', 'DENIED']);
const LEVEL_BY_DOMAIN = Object.freeze({
  BACKEND_LOGICAL: 'BACKEND_ACCEPTED',
  COMMUNICATION: 'COMMUNICATION_ACK',
  PHYSICAL: 'PHYSICAL_STATE_CONFIRMED',
});

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function iso(value) {
  if (!text(value) || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(Date.parse(value)).toISOString() === value; } catch { return false; }
}
function result(status, code, message, details = {}) {
  return Object.freeze({ status, code, message, details: Object.freeze(details) });
}

/**
 * Validate a proposed initial lifecycle baseline against an explicitly supplied
 * governance projection and an injected allowlist of independently trusted sources.
 * No baseline is created, corrected, or persisted by this pure validator.
 */
export function validateLifecycleBaseline(baseline, {
  expectedCpsId,
  governance,
  trustedSources,
  verifyProvenance,
  now = new Date().toISOString(),
  maxAgeMs,
} = {}) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_MISSING', 'No lifecycle baseline was supplied.');
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_FRESHNESS_POLICY_MISSING', 'An explicit non-negative maxAgeMs policy is required.');
  }
  if (!iso(now)) return result('FAIL', 'LIFECYCLE_BASELINE_VALIDATION_TIME_INVALID', 'now must be an ISO-8601 UTC timestamp.');
  if (baseline.schemaVersion !== '1.0') return result('FAIL', 'LIFECYCLE_BASELINE_SCHEMA_UNSUPPORTED', 'schemaVersion must be 1.0.');

  const required = ['cpsId', 'plugEventId', 'plugCycleId', 'profileId', 'lifecycleState', 'governanceStatus'];
  const missing = required.filter((key) => !text(baseline[key]));
  if (missing.length) return result('BLOCKED', 'LIFECYCLE_BASELINE_FIELDS_MISSING', 'Baseline identity or state is incomplete.', { fields: missing });
  const source = baseline.source;
  const provenance = baseline.provenance;
  const ref = baseline.evidenceReference;
  if (!source || !text(source.system) || !text(source.component) || !text(source.recordId) || !Object.hasOwn(LEVEL_BY_DOMAIN, source.domain)) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_SOURCE_MISSING', 'A source record and its state domain are required.');
  }
  if (!provenance || !text(provenance.kind) || !text(provenance.issuer) || !text(provenance.verificationId)) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_PROVENANCE_MISSING', 'Verifiable provenance is required.');
  }
  if (!ref || !text(ref.recordId) || !/^[a-f0-9]{64}$/i.test(text(ref.sha256))) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_EVIDENCE_REFERENCE_MISSING', 'A durable evidence reference and SHA-256 are required.');
  }
  if (!iso(baseline.observedAt) || !iso(baseline.verifiedAt) || Date.parse(baseline.verifiedAt) < Date.parse(baseline.observedAt)) {
    return result('FAIL', 'LIFECYCLE_BASELINE_TIMESTAMP_INVALID', 'observedAt and verifiedAt must be valid UTC timestamps in order.');
  }
  if (Date.parse(baseline.verifiedAt) > Date.parse(now)) return result('FAIL', 'LIFECYCLE_BASELINE_VERIFIED_IN_FUTURE', 'verifiedAt cannot be in the future.');
  if (Date.parse(now) - Date.parse(baseline.observedAt) > maxAgeMs) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_STALE', 'The observed baseline exceeds the injected freshness window.', { observedAt: baseline.observedAt, maxAgeMs });
  }
  if (text(baseline.confirmationLevel) !== LEVEL_BY_DOMAIN[source.domain]) {
    return result('FAIL', 'LIFECYCLE_BASELINE_CONFIRMATION_DOMAIN_CONFLICT', 'confirmationLevel does not match source.domain.');
  }

  const trust = Array.isArray(trustedSources) ? trustedSources : [];
  const trusted = trust.some((entry) => entry?.system === source.system && entry?.component === source.component &&
    entry?.domain === source.domain && Array.isArray(entry.provenanceKinds) && entry.provenanceKinds.includes(provenance.kind));
  if (!trusted) return result('BLOCKED', 'LIFECYCLE_BASELINE_SOURCE_UNTRUSTED', 'The source/provenance pair is not in the injected trust policy.');
  if (typeof verifyProvenance !== 'function') return result('BLOCKED', 'LIFECYCLE_BASELINE_PROVENANCE_VERIFIER_MISSING', 'A server-side provenance verifier must be injected.');
  let receipt;
  try { receipt = verifyProvenance(structuredClone(baseline)); }
  catch { return result('BLOCKED', 'LIFECYCLE_BASELINE_PROVENANCE_UNVERIFIED', 'The provenance verifier could not validate the evidence.'); }
  if (receipt?.verified !== true || receipt.verificationId !== provenance.verificationId ||
      receipt.system !== source.system || receipt.component !== source.component || receipt.contentHash !== ref.sha256) {
    return result('BLOCKED', 'LIFECYCLE_BASELINE_PROVENANCE_UNVERIFIED', 'The provenance receipt does not authenticate this source and evidence hash.');
  }

  if (expectedCpsId && baseline.cpsId !== expectedCpsId) return result('FAIL', 'LIFECYCLE_BASELINE_CPS_CONFLICT', 'Baseline belongs to another CPS.', { expectedCpsId, actualCpsId: baseline.cpsId });
  if (!governance || typeof governance !== 'object') return result('BLOCKED', 'LIFECYCLE_BASELINE_GOVERNANCE_PROJECTION_MISSING', 'A separately obtained governance projection is required.');
  for (const field of ['cpsId', 'plugEventId', 'plugCycleId', 'profileId']) {
    if (text(governance[field]) !== baseline[field]) return result('FAIL', 'LIFECYCLE_BASELINE_GOVERNANCE_IDENTITY_CONFLICT', `Governance ${field} does not match baseline.`, { field });
  }
  if (governance.cycleState !== 'ACTIVE') return result('FAIL', 'LIFECYCLE_BASELINE_CYCLE_NOT_ACTIVE', 'Only the explicitly correlated active legacy cycle can be baselined.');
  if (!GOVERNANCE.has(governance.governanceStatus) || baseline.governanceStatus !== governance.governanceStatus) {
    return result('FAIL', 'LIFECYCLE_BASELINE_GOVERNANCE_STATUS_CONFLICT', 'Governance status is invalid or differs from the correlated profile.');
  }
  if (!STATES.has(String(baseline.lifecycleState).toLowerCase()) || !['plug', 'play'].includes(String(baseline.lifecycleState).toLowerCase())) {
    return result('FAIL', 'LIFECYCLE_BASELINE_ACTIVE_STATE_CONFLICT', 'An ACTIVE governance cycle requires a lifecycle phase of plug or play; no physical state is inferred.');
  }
  if (governance.profilePlugCycleStatus && governance.profilePlugCycleStatus !== 'ACTIVE') {
    return result('FAIL', 'LIFECYCLE_BASELINE_PROFILE_CYCLE_STATUS_CONFLICT', 'Profile and governance cycle do not both identify an active cycle.');
  }
  return result('PASS', 'LIFECYCLE_BASELINE_VALID', 'Baseline is structurally consistent and source-authorized under the injected policy.', {
    cpsId: baseline.cpsId, plugCycleId: baseline.plugCycleId, profileId: baseline.profileId,
    confirmationLevel: baseline.confirmationLevel, lifecycleState: baseline.lifecycleState,
  });
}

/** Evaluate the required LAI set and detect duplicate cycles/events across CPSs. */
export function validateLifecycleBaselineSet({ baselines = [], governanceRows = [], expectedCpsIds = CPS_LAI_IDS, ...policy } = {}) {
  const byCps = new Map();
  const errors = new Map();
  for (const baseline of baselines) {
    const cpsId = text(baseline?.cpsId);
    if (!cpsId) continue;
    if (byCps.has(cpsId)) errors.set(cpsId, result('FAIL', 'LIFECYCLE_BASELINE_DUPLICATE_CPS', 'More than one baseline was supplied for a CPS.'));
    else byCps.set(cpsId, baseline);
  }
  const governanceByCps = new Map();
  for (const row of governanceRows) {
    const cpsId = text(row?.cpsId);
    if (!cpsId) continue;
    if (governanceByCps.has(cpsId)) errors.set(cpsId, result('FAIL', 'LIFECYCLE_BASELINE_MULTIPLE_ACTIVE_CYCLES', 'Governance projection contains multiple rows for one CPS.'));
    else governanceByCps.set(cpsId, row);
  }
  const duplicateIds = new Set();
  for (const field of ['plugCycleId', 'plugEventId']) {
    const seen = new Map();
    for (const baseline of baselines) {
      const value = text(baseline?.[field]);
      if (!value) continue;
      if (seen.has(value)) { duplicateIds.add(seen.get(value)); duplicateIds.add(baseline.cpsId); }
      else seen.set(value, baseline.cpsId);
    }
  }
  return Object.freeze(expectedCpsIds.map((cpsId) => {
    let validation = errors.get(cpsId);
    const baseline = byCps.get(cpsId);
    if (!validation) validation = !baseline
      ? result('BLOCKED', 'LIFECYCLE_BASELINE_MISSING', `No baseline supplied for ${cpsId}.`)
      : validateLifecycleBaseline(baseline, { ...policy, expectedCpsId: cpsId, governance: governanceByCps.get(cpsId) });
    if (duplicateIds.has(cpsId)) validation = result('FAIL', 'LIFECYCLE_BASELINE_DUPLICATE_CYCLE_OR_EVENT', 'A plugCycleId or plugEventId is reused across CPS baselines.');
    return Object.freeze({ cpsId, ...validation });
  }));
}

export const LIFECYCLE_BASELINE_CPS_IDS = CPS_LAI_IDS;
