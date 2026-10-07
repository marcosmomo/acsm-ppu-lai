import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GOVERNANCE_STATUS,
  approveGovernanceProfileSnapshot,
  buildGovernanceProfile,
  evaluateGovernancePolicy,
  getGovernanceTemplateForCps,
  isGovernanceProfileApproved,
} from '../lib/governance/policies.js';
import { evaluateLifecyclePlayGate } from '../lib/governance/lifecycleGate.mjs';
import {
  canApproveLifecycleGovernance,
  governancePermitsPlay,
} from '../lib/governance/uiState.mjs';
import {
  approveGovernanceProfile,
  closeGovernancePlugCycle,
  createGovernanceProfileForPlug,
  getActiveGovernanceProfile,
  ensureGovernanceProfile,
  getGovernanceProfile,
  rejectGovernanceProfile,
} from '../services/governance/governanceStore.js';
import {
  getPlugState,
  transitionPlugAssetLifecycle,
  updatePlugSnapshot,
} from '../lib/acsm/plugStore.mjs';

const cpsCases = [
  ['cpslai1', 'DISTRIBUTION_CONVEYOR', 'ADJUST_TRANSPORT_SPEED'],
  ['cpslai2', 'JOINING', 'ADJUST_JOINING_FORCE'],
  ['cpslai3', 'SORTING', 'ADJUST_SORTING_THRESHOLD'],
];

const storeFile = (name) =>
  path.join(os.tmpdir(), `acsm-governance-${name}-${process.pid}-${Date.now()}-${Math.random()}.json`);

const plugStateFor = (...cpsIds) => ({
  assets: cpsIds.map((cpsId) => ({
    cps: { cpsId, lifecyclePhase: 'plug' },
    aas: { id: `urn:test:${cpsId}:aas`, idShort: `${cpsId.toUpperCase()}_AAS` },
    interfaces: { baseTopic: cpsId },
  })),
});

for (const [cpsId, template, action] of cpsCases) {
  test(`${cpsId}: Plug creates one idempotent pending profile and approval gates Play`, () => {
    process.env.GOVERNANCE_STORE_PATH = storeFile(cpsId);
    const first = createGovernanceProfileForPlug(cpsId, { id: cpsId });
    const repeated = createGovernanceProfileForPlug(cpsId, { id: cpsId });

    assert.equal(first.created, true);
    assert.equal(first.profile.status, GOVERNANCE_STATUS.PENDING_APPROVAL);
    assert.equal(first.profile.template, template);
    assert.equal(first.activeProfile.profileId, first.profile.profileId);
    assert.equal(first.activeProfile.plugCycleStatus, 'ACTIVE');
    assert.equal(getActiveGovernanceProfile(cpsId).profileId, first.profile.profileId);
    assert.equal(first.profile.policies.governableActions[0].action, action);
    assert.equal(repeated.created, false);
    assert.equal(repeated.profile.profileId, first.profile.profileId);
    assert.equal(repeated.profile.profileVersion, 1);

    const pendingGate = evaluateLifecyclePlayGate({
      cpsId,
      profile: first.profile,
      plugState: plugStateFor(cpsId),
    });
    assert.equal(pendingGate.ok, false);
    assert.equal(pendingGate.status, 409);
    assert.equal(pendingGate.reason, 'GOVERNANCE_APPROVAL_REQUIRED');
    assert.equal(pendingGate.governanceStatus, GOVERNANCE_STATUS.PENDING_APPROVAL);

    const approved = approveGovernanceProfile(cpsId, 'test-operator').profile;
    assert.equal(approved.status, GOVERNANCE_STATUS.APPROVED);
    assert.equal(approved.approvedBy, 'test-operator');
    assert.ok(approved.approvedAt);
    assert.equal(isGovernanceProfileApproved(approved), true);

    const approvedGate = evaluateLifecyclePlayGate({
      cpsId,
      profile: approved,
      plugState: plugStateFor(cpsId),
    });
    assert.equal(approvedGate.ok, true);
    assert.equal(approvedGate.reason, 'GOVERNANCE_GATE_PASSED');

    const closed = closeGovernancePlugCycle(cpsId).profile;
    assert.equal(closed.plugCycleStatus, 'CLOSED');
    assert.equal(getActiveGovernanceProfile(cpsId), null);
    assert.equal(getGovernanceProfile(cpsId).activeProfile, null);
    assert.equal(getGovernanceProfile(cpsId).profiles.at(-1).profileId, approved.profileId);

    const closedLookup = ensureGovernanceProfile(cpsId, { id: cpsId });
    assert.equal(closedLookup.profile, null);
    assert.equal(closedLookup.activeProfile, null);
    assert.equal(closedLookup.history.at(-1).profileId, approved.profileId);

    const nextPlug = createGovernanceProfileForPlug(cpsId, { id: cpsId });
    const repeatedNextPlug = createGovernanceProfileForPlug(cpsId, { id: cpsId });
    assert.equal(nextPlug.created, true);
    assert.equal(nextPlug.newPlugCycle, true);
    assert.equal(nextPlug.profile.profileVersion, 2);
    assert.notEqual(nextPlug.profile.profileId, approved.profileId);
    assert.equal(nextPlug.profile.status, GOVERNANCE_STATUS.PENDING_APPROVAL);
    assert.equal(getGovernanceProfile(cpsId).activeProfile.profileId, nextPlug.profile.profileId);
    assert.equal(nextPlug.profile.approvedAt, null);
    assert.equal(nextPlug.profile.approvedBy, null);
    assert.equal(repeatedNextPlug.created, false);
    assert.equal(repeatedNextPlug.profile.profileId, nextPlug.profile.profileId);
    assert.equal(repeatedNextPlug.profiles.length, 2);
    assert.equal(repeatedNextPlug.profiles[0].profileId, approved.profileId);
    assert.equal(repeatedNextPlug.profiles[0].status, GOVERNANCE_STATUS.APPROVED);

    const denied = rejectGovernanceProfile(cpsId, 'test-operator').profile;
    assert.equal(denied.status, GOVERNANCE_STATUS.DENIED);
    const deniedGate = evaluateLifecyclePlayGate({
      cpsId,
      profile: denied,
      plugState: plugStateFor(cpsId),
    });
    assert.equal(deniedGate.ok, false);
    assert.equal(deniedGate.reason, 'GOVERNANCE_APPROVAL_REQUIRED');
    assert.equal(deniedGate.governanceStatus, GOVERNANCE_STATUS.DENIED);

    const getResult = getGovernanceProfile(cpsId);
    assert.equal(getResult.profile.profileId, nextPlug.profile.profileId);
    assert.equal(getResult.profile.profileVersion, 2);
    assert.equal(getResult.profile.status, GOVERNANCE_STATUS.DENIED);
    assert.equal(getResult.profiles.length, 2);
  });
}

test('approval is isolated per CPS', () => {
  process.env.GOVERNANCE_STORE_PATH = storeFile('isolation');
  for (const [cpsId] of cpsCases) createGovernanceProfileForPlug(cpsId, { id: cpsId });
  approveGovernanceProfile('cpslai1', 'operator-a');

  assert.equal(getGovernanceProfile('cpslai1').profile.status, GOVERNANCE_STATUS.APPROVED);
  assert.equal(getGovernanceProfile('cpslai2').profile.status, GOVERNANCE_STATUS.PENDING_APPROVAL);
  assert.equal(getGovernanceProfile('cpslai3').profile.status, GOVERNANCE_STATUS.PENDING_APPROVAL);
});

test('Play gate also requires Plug registration and a valid AAS reference', () => {
  const profile = approveGovernanceProfileSnapshot(buildGovernanceProfile('cpslai1'));
  const missingRegistration = evaluateLifecyclePlayGate({ cpsId: 'cpslai1', profile, plugState: { assets: [] } });
  assert.equal(missingRegistration.reason, 'CPS_NOT_REGISTERED');

  const missingAas = evaluateLifecyclePlayGate({
    cpsId: 'cpslai1',
    profile,
    plugState: { assets: [{ cps: { cpsId: 'cpslai1' } }] },
  });
  assert.equal(missingAas.reason, 'AAS_REQUIRED');
});

test('GET-equivalent lookup does not create a profile before Plug', () => {
  process.env.GOVERNANCE_STORE_PATH = storeFile('before-plug');
  const result = getGovernanceProfile('cpslai1');
  assert.equal(result.profile, null);
  assert.equal(result.governanceStatus, GOVERNANCE_STATUS.NOT_DEFINED);

  const ensured = ensureGovernanceProfile('cpslai1', { id: 'cpslai1' });
  assert.equal(ensured.profile, null);
  assert.equal(ensured.activeProfile, null);
  assert.equal(ensured.governanceStatus, GOVERNANCE_STATUS.NOT_DEFINED);
  assert.equal(getGovernanceProfile('cpslai1').profiles.length, 0);
});

test('explicit Plug action creates an active profile and snapshot only projects it for every CPS', () => {
  for (const [cpsId, , action] of cpsCases) {
    process.env.GOVERNANCE_STORE_PATH = storeFile(`explicit-plug-${cpsId}`);
    const previous = createGovernanceProfileForPlug(
      cpsId,
      { id: cpsId },
      { plugEventId: `${cpsId}-previous-plug` }
    );
    approveGovernanceProfile(cpsId, 'previous-operator');
    const asset = {
      cps: { cpsId, lifecyclePhase: 'registered' },
      aas: { id: `urn:test:${cpsId}:aas` },
      interfaces: { baseTopic: cpsId },
    };

    updatePlugSnapshot({ acsmId: 'acsm1', assets: [asset] });
    assert.equal(
      getPlugState().assets[0].governance.status,
      'NOT_DEFINED',
      'registered discovery must not expose an older cycle as the active Plug profile'
    );

    const eventId = `${cpsId}-manual-plug-event-2`;
    const created = createGovernanceProfileForPlug(cpsId, { id: cpsId }, { plugEventId: eventId });
    const retried = createGovernanceProfileForPlug(cpsId, { id: cpsId }, { plugEventId: eventId });
    assert.equal(created.profile.profileVersion, previous.profile.profileVersion + 1);
    assert.equal(created.activeProfile.plugCycleStatus, 'ACTIVE');
    assert.equal(created.activeProfile.status, GOVERNANCE_STATUS.PENDING_APPROVAL);
    assert.equal(created.activeProfile.policies.governableActions[0].action, action);
    assert.equal(retried.profile.profileId, created.profile.profileId, 'same Plug event retry is idempotent');
    assert.equal(created.activeProfile.approvedAt, null);
    assert.equal(created.activeProfile.approvedBy, null);
    assert.equal(created.history[0].status, GOVERNANCE_STATUS.APPROVED);
    assert.equal(created.history[0].plugCycleStatus, 'CLOSED');

    const transition = transitionPlugAssetLifecycle(cpsId, 'plug');
    assert.equal(transition.ok, true);
    assert.equal(transition.lifecyclePhase, 'plug');
    const projected = getPlugState();
    const current = projected.assets.find((item) => item.cps.cpsId === cpsId)?.governance;
    assert.equal(current.activeProfile.profileId, created.activeProfile.profileId);
    assert.equal(current.status, GOVERNANCE_STATUS.PENDING_APPROVAL);
    assert.equal(canApproveLifecycleGovernance({ registered: true, profile: current.activeProfile }), true);
    assert.equal(governancePermitsPlay({ registered: true, profile: current.activeProfile }), false);
  }
});

test('UI lifecycle governance predicates are isolated and status-driven', () => {
  const pending = buildGovernanceProfile('cpslai2');
  const approved = approveGovernanceProfileSnapshot(pending);
  const denied = { ...pending, status: GOVERNANCE_STATUS.DENIED };

  assert.equal(canApproveLifecycleGovernance({ registered: true, profile: pending }), true);
  assert.equal(governancePermitsPlay({ registered: true, profile: pending }), false);
  assert.equal(canApproveLifecycleGovernance({ registered: true, profile: approved }), false);
  assert.equal(governancePermitsPlay({ registered: true, profile: approved }), true);
  assert.equal(canApproveLifecycleGovernance({ registered: true, profile: denied }), false);
  assert.equal(governancePermitsPlay({ registered: true, profile: denied }), false);
  assert.equal(canApproveLifecycleGovernance({ registered: false, profile: pending }), false);
});

test('Recommendation Governance remains separate from the lifecycle gate', () => {
  const profile = approveGovernanceProfileSnapshot(buildGovernanceProfile('cpslai3'));
  const decision = evaluateGovernancePolicy({
    profile,
    action: 'ADJUST_SORTING_THRESHOLD',
    variation: 6,
  });
  assert.equal(getGovernanceTemplateForCps('cpslai3').template, 'SORTING');
  assert.equal(decision.decision, 'HUMAN_APPROVAL');
  assert.equal(isGovernanceProfileApproved(profile), true);
});
