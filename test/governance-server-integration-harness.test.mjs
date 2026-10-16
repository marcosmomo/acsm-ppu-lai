import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from '../lib/governance/transactionalGovernanceAdapters.mjs';
import {
  GOVERNANCE_HARNESS_MODES,
  createGovernanceServerIntegrationHarness,
} from '../lib/governance/governanceServerIntegrationHarness.mjs';

const fixture = path.resolve('test/fixtures/governance-repository/current-valid.json');
const fixedNow = () => '2026-10-14T20:00:00.000Z';
const trusted = (request) => ({
  authenticated: true, authorized: true, trusted: true,
  provenance: 'SERVER_AUTHENTICATION', subject: 'operator-harness',
  roles: ['GOVERNANCE_OPERATOR'], authenticationId: 'auth-test-1',
  authenticatedAt: '2026-10-14T19:59:00.000Z', permission: request.requiredPermission,
});

function evidence(request) {
  const identity = request.expectedIdentity;
  return {
    accepted: true, transitionId: `${request.expectedPhase}-transition-test`,
    phase: request.expectedPhase, source: 'INJECTED_TEST_PROVIDER', ...identity,
  };
}

async function isolated(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-governance-http-harness-'));
  const filePath = path.join(root, 'candidate-governance.json');
  fs.copyFileSync(fixture, filePath);
  const repository = new GovernanceRepository({ filePath });
  const facade = new TransactionalGovernanceFacade({ repository, now: fixedNow });
  const adapters = new TransactionalGovernanceAdapters({ facade });
  const harness = createGovernanceServerIntegrationHarness({
    mode: GOVERNANCE_HARNESS_MODES.ISOLATED_TRANSACTIONAL_TEST,
    adapters, storePath: filePath, temporaryRoot: root,
    authorizationProvider: options.authorizationProvider ?? trusted,
    lifecycleEvidenceProvider: options.lifecycleEvidenceProvider ?? evidence,
  });
  try { return await run({ root, filePath, repository, facade, adapters, harness }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function plugRequest(plugEventId = 'plug-harness-1', expectedRevision = 0, functionalVersion = '1') {
  return {
    operation: 'PLUG', params: { cpsId: 'cpslai1' },
    body: {
      cpsId: 'ignored-body-cps', plugEventId, expectedRevision,
      cps: { id: 'cpslai1' },
      identity: { aasId: 'urn:test:harness:cpslai1', assetId: 'asset-harness', functionalVersion },
    },
  };
}

function ids(response) {
  return {
    cpsId: response.body.cycle.cpsId,
    plugEventId: response.body.cycle.plugEventId,
    plugCycleId: response.body.cycle.plugCycleId,
    profileId: response.body.profile.profileId,
  };
}

function request(operation, identity, expectedRevision, extra = {}) {
  return { operation, params: { cpsId: identity.cpsId }, body: { ...identity, expectedRevision, ...extra } };
}

function reserveAndActivate(harness) {
  const reserved = harness.handle(plugRequest());
  const identity = ids(reserved);
  const activated = harness.handle(request('ACTIVATE_PLUG', identity, reserved.body.expectedRevision));
  assert.equal(activated.status, 200);
  return { identity, activated };
}

test('SHADOW_READ_ONLY compares supplied projections and cannot receive writer dependencies', () => {
  const harness = createGovernanceServerIntegrationHarness({ mode: GOVERNANCE_HARNESS_MODES.SHADOW_READ_ONLY });
  const legacyDocument = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const candidateDocument = structuredClone(legacyDocument);
  const before = JSON.stringify({ legacyDocument, candidateDocument });
  const response = harness.handle({ operation: 'SHADOW_COMPARE', body: { legacyDocument, candidateDocument } });
  assert.equal(response.status, 200);
  assert.equal(response.body.comparison.compatible, true);
  assert.equal(JSON.stringify({ legacyDocument, candidateDocument }), before);
  assert.equal(harness.handle({ operation: 'PLUG', body: {} }).status, 405);
  assert.throws(() => createGovernanceServerIntegrationHarness({ mode: GOVERNANCE_HARNESS_MODES.SHADOW_READ_ONLY, adapters: {} }), { code: 'GOVERNANCE_SHADOW_DEPENDENCY_FORBIDDEN' });
});

test('transactional mode rejects workspace and mismatched Repository paths before handling requests', () => {
  const workspaceFile = path.resolve('data/governance-store.json');
  assert.throws(() => createGovernanceServerIntegrationHarness({
    mode: GOVERNANCE_HARNESS_MODES.ISOLATED_TRANSACTIONAL_TEST,
    adapters: { facade: { repository: { filePath: workspaceFile } } },
    storePath: workspaceFile, temporaryRoot: path.resolve('.'),
  }), { code: 'GOVERNANCE_HARNESS_NON_TEMP_PATH_FORBIDDEN' });
});

test('first Plug preserves legacy response fields and adds full correlation plus revision', () => isolated(({ harness }) => {
  const response = harness.handle(plugRequest());
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(response.body.activeProfile.profileId, response.body.profileId);
  for (const field of ['plugEventId', 'plugCycleId', 'profileId', 'expectedRevision']) assert.notEqual(response.body[field], undefined);
  assert.equal(response.body.effects.length, 0);
}));

test('same Plug retry is write-free and different event conflicts with HTTP 409', () => isolated(({ harness, filePath }) => {
  const first = harness.handle(plugRequest());
  const bytes = fs.readFileSync(filePath, 'utf8');
  const retry = harness.handle(plugRequest('plug-harness-1', first.body.expectedRevision));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.expectedRevision, first.body.expectedRevision);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
  const conflict = harness.handle(plugRequest('plug-harness-2', first.body.expectedRevision, '2'));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.details.code, 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT');
}));

test('activation requires injected evidence bound to all identifiers and expected phase', () => isolated(({ harness }) => {
  const reserved = harness.handle(plugRequest());
  const activated = harness.handle(request('ACTIVATE_PLUG', ids(reserved), reserved.body.expectedRevision));
  assert.equal(activated.status, 200);
  assert.equal(activated.body.cycle.state, 'ACTIVE');
  assert.equal(activated.body.cycle.activationEvidence.source, 'INJECTED_TEST_PROVIDER');
}, { lifecycleEvidenceProvider: evidence }));

test('missing or divergent lifecycle evidence cannot activate a cycle', () => isolated(({ harness }) => {
  const reserved = harness.handle(plugRequest());
  const response = harness.handle(request('ACTIVATE_PLUG', ids(reserved), reserved.body.expectedRevision));
  assert.equal(response.status, 400);
  assert.equal(response.body.details.code, 'GOVERNANCE_CORRELATED_LIFECYCLE_EVIDENCE_REQUIRED');
}, { lifecycleEvidenceProvider: () => null }));

test('lifecycle evidence with a divergent cycle identity returns HTTP 409', () => isolated(({ harness }) => {
  const reserved = harness.handle(plugRequest());
  const response = harness.handle(request('ACTIVATE_PLUG', ids(reserved), reserved.body.expectedRevision));
  assert.equal(response.status, 409);
  assert.equal(response.body.details.code, 'GOVERNANCE_LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT');
}, { lifecycleEvidenceProvider: (providerRequest) => ({ ...evidence(providerRequest), plugCycleId: 'wrong-cycle' }) }));

test('authentication absence is 401, authorization absence is 403, and frontend actor fields are ignored', async () => {
  await isolated(({ harness }) => {
    const { identity, activated } = reserveAndActivate(harness);
    const response = harness.handle(request('APPROVE_PROFILE', identity, activated.body.expectedRevision, { approvedBy: 'frontend-spoof' }));
    assert.equal(response.status, 401);
  }, { authorizationProvider: () => null });
  await isolated(({ harness }) => {
    const { identity, activated } = reserveAndActivate(harness);
    const response = harness.handle(request('APPROVE_PROFILE', identity, activated.body.expectedRevision, { approvedBy: 'frontend-spoof' }));
    assert.equal(response.status, 403);
  }, { authorizationProvider: () => ({ authenticated: true, authorized: false }) });
  await isolated(({ harness }) => {
    const { identity, activated } = reserveAndActivate(harness);
    const response = harness.handle(request('APPROVE_PROFILE', identity, activated.body.expectedRevision, { approvedBy: 'frontend-spoof' }));
    assert.equal(response.status, 200);
    assert.equal(response.body.profile.approvedBy, 'operator-harness');
  });
});

test('approval and rejection are mutually exclusive and obsolete profile identity is HTTP 409', async () => {
  await isolated(({ harness }) => {
    const { identity, activated } = reserveAndActivate(harness);
    const stale = harness.handle(request('APPROVE_PROFILE', { ...identity, profileId: 'historical-profile' }, activated.body.expectedRevision));
    assert.equal(stale.status, 409);
    const approved = harness.handle(request('APPROVE_PROFILE', identity, activated.body.expectedRevision));
    assert.equal(approved.body.governanceStatus, 'APPROVED');
    const rejected = harness.handle(request('REJECT_PROFILE', identity, approved.body.expectedRevision));
    assert.equal(rejected.status, 409);
  });
  await isolated(({ harness }) => {
    const { identity, activated } = reserveAndActivate(harness);
    const rejected = harness.handle(request('REJECT_PROFILE', identity, activated.body.expectedRevision));
    assert.equal(rejected.body.governanceStatus, 'DENIED');
  });
});

test('Play-gate blocks pending profile and passes only approved active correlated profile', () => isolated(({ harness }) => {
  const { identity, activated } = reserveAndActivate(harness);
  const blocked = harness.handle(request('PLAY_GATE', identity, activated.body.expectedRevision, { lifecyclePhase: 'play' }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.ok, false);
  assert.equal(blocked.body.reason, 'GOVERNANCE_APPROVAL_REQUIRED');
  const approved = harness.handle(request('APPROVE_PROFILE', identity, activated.body.expectedRevision));
  const passed = harness.handle(request('PLAY_GATE', identity, approved.body.expectedRevision, { lifecyclePhase: 'play' }));
  assert.equal(passed.body.ok, true);
  assert.equal(passed.body.reason, 'GOVERNANCE_GATE_PASSED');
}));

test('policy updates use exact current identity, trusted principal and revision CAS', () => isolated(({ harness }) => {
  const { identity, activated } = reserveAndActivate(harness);
  const changed = harness.handle(request('UPDATE_POLICIES', identity, activated.body.expectedRevision, {
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 5, humanApprovalLimit: 15 }] },
    updatedBy: 'frontend-spoof',
  }));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.profile.updatedBy, 'operator-harness');
  const stale = harness.handle(request('UPDATE_POLICIES', identity, activated.body.expectedRevision, {
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 6, humanApprovalLimit: 16 }] },
  }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'GOVERNANCE_REVISION_CONFLICT');
}));

test('governed action records effectIntent but executes no effect', () => isolated(({ harness }) => {
  const { identity, activated } = reserveAndActivate(harness);
  const approved = harness.handle(request('APPROVE_PROFILE', identity, activated.body.expectedRevision));
  const created = harness.handle(request('CREATE_GOVERNED_ACTION', identity, approved.body.expectedRevision, {
    actionId: 'GA-HARNESS-1', action: 'ADJUST_TRANSPORT_SPEED', requestedValue: 12, variation: 12,
  }));
  const decided = harness.handle({
    operation: 'DECIDE_GOVERNED_ACTION', params: { actionId: created.body.action.actionId },
    body: { ...identity, expectedRevision: created.body.expectedRevision, decision: 'APPROVED', decidedBy: 'frontend-spoof' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.action.executionStatus, 'PENDING_EXECUTION');
  assert.equal(decided.body.action.effectIntent.type, 'GOVERNED_ACTION_EXECUTION');
  assert.equal(decided.body.effects.length, 1);
}));

test('outbox is inspectable but never published by the harness', () => isolated(({ harness }) => {
  harness.handle(plugRequest());
  const response = harness.handle({ operation: 'LIST_OUTBOX' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ppuOutbox.length, 1);
  assert.equal(response.body.published, false);
  assert.deepEqual(response.body.effects, []);
  assert.equal(harness.handle({ operation: 'MARK_OUTBOX_PUBLISHED' }).status, 405);
}));

test('correlated Unplug closes exact cycle, delayed Unplug cannot close replug cycle', () => isolated(({ harness }) => {
  const { identity, activated } = reserveAndActivate(harness);
  const closed = harness.handle(request('UNPLUG', identity, activated.body.expectedRevision));
  assert.equal(closed.status, 200);
  assert.equal(closed.body.cycle.state, 'CLOSED');
  const replug = harness.handle(plugRequest('plug-harness-2', closed.body.expectedRevision, '2'));
  assert.equal(replug.status, 200);
  assert.equal(replug.body.governanceStatus, 'PENDING_APPROVAL');
  const delayed = harness.handle(request('UNPLUG', identity, replug.body.expectedRevision));
  assert.equal(delayed.status, 409);
  assert.equal(delayed.body.details.code, 'GOVERNANCE_UNPLUG_IDENTITY_CONFLICT');
}));

test('committed state is recovered by a newly constructed harness without operational access', () => isolated(({ harness, filePath, root }) => {
  const reserved = harness.handle(plugRequest());
  const repository = new GovernanceRepository({ filePath });
  const facade = new TransactionalGovernanceFacade({ repository, now: fixedNow });
  const restarted = createGovernanceServerIntegrationHarness({
    mode: GOVERNANCE_HARNESS_MODES.ISOLATED_TRANSACTIONAL_TEST,
    adapters: new TransactionalGovernanceAdapters({ facade }), storePath: filePath, temporaryRoot: root,
    authorizationProvider: trusted, lifecycleEvidenceProvider: evidence,
  });
  const profile = restarted.handle({ operation: 'GET_PROFILE', params: { cpsId: 'cpslai1' } });
  assert.equal(profile.body.profile.profileId, reserved.body.profileId);
  assert.equal(profile.body.expectedRevision, reserved.body.expectedRevision);
}));

test('harness source contains no server, localhost, broker, physical or operational Store dependency', () => {
  const source = fs.readFileSync(path.resolve('lib/governance/governanceServerIntegrationHarness.mjs'), 'utf8').toLowerCase();
  for (const forbidden of ['governancestore', 'localhost', 'mqtt', 'opcua', 'axios', 'fetch(', 'http.create', 'https.create', 'listen(', 'executeacsm', 'evolution']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
