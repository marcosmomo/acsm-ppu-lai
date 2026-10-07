import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  updatePlugSnapshot,
  getPlugState,
  transitionPlugAssetLifecycle,
} from '../lib/acsm/plugStore.mjs';
import { executeAcsmUnplug } from '../lib/acsm/unplugLifecycle.mjs';
import { publishUnplugNotificationIfAvailable } from '../lib/acsm/unplugNotification.mjs';
import {
  approveGovernanceProfile,
  createGovernanceProfileForPlug,
  getGovernanceProfile,
  rejectGovernanceProfile,
} from '../services/governance/governanceStore.js';

const cpsIds = ['cpslai1', 'cpslai2', 'cpslai3'];
const storePath = path.join(os.tmpdir(), `acsm-unplug-${process.pid}-${Date.now()}.json`);
process.env.GOVERNANCE_STORE_PATH = storePath;

const makeAssets = (phase = 'play') => cpsIds.map((cpsId) => ({
  cps: { cpsId, id: cpsId, displayName: cpsId, lifecyclePhase: phase },
  aas: { id: `urn:test:${cpsId}:aas` },
  interfaces: { baseTopic: cpsId },
}));

test('Unplug succeeds without MQTT, closes governance, removes Play projection and allows fresh re-Plug', async () => {
  const initialAssets = makeAssets('play');
  updatePlugSnapshot({ acsmId: 'acsm1', operationallyLinked: 3, assets: initialAssets });

  for (const [index, cpsId] of cpsIds.entries()) {
    const profile = createGovernanceProfileForPlug(cpsId, { id: cpsId }).profile;
    if (index === 0) approveGovernanceProfile(cpsId, 'operator');
    if (index === 1) rejectGovernanceProfile(cpsId, 'operator');
    if (index === 2) assert.equal(profile.status, 'PENDING_APPROVAL');
  }

  for (const cpsId of cpsIds) {
    const body = executeAcsmUnplug(cpsId, '2026-10-07T15:00:00.000Z');
    assert.equal(body.ok, true);
    assert.equal(body.lifecyclePhase, 'unplug');
    assert.equal(body.operationalState, 'unplugged');
    assert.equal(body.plugCycleStatus, 'CLOSED');

    const active = getPlugState().assets.find((asset) => asset.cps.cpsId === cpsId);
    assert.equal(active.cps.lifecyclePhase, 'unplug');
    assert.equal(active.cps.operationalState, 'unplugged');
    assert.equal(active.governance.activeProfile, null);
    assert.equal(getGovernanceProfile(cpsId).activeProfile, null);
    assert.equal(getGovernanceProfile(cpsId).history.at(-1).plugCycleStatus, 'CLOSED');
    assert.equal(getGovernanceProfile(cpsId).profiles.length, 1);
  }

  assert.equal(getPlugState().summary.operationallyLinked, 0);

  const replugAssets = makeAssets('plug');
  for (const asset of replugAssets) {
    createGovernanceProfileForPlug(asset.cps.cpsId, asset.cps);
    assert.equal(transitionPlugAssetLifecycle(asset.cps.cpsId, 'plug').ok, true);
  }

  for (const cpsId of cpsIds) {
    const governance = getGovernanceProfile(cpsId);
    assert.equal(governance.profile.status, 'PENDING_APPROVAL');
    assert.equal(governance.profile.plugCycleStatus, 'ACTIVE');
    assert.equal(governance.profile.profileVersion, 2);
    const plugProjection = getPlugState().assets.find((asset) => asset.cps.cpsId === cpsId);
    assert.equal(plugProjection.governance.activeProfile.profileId, governance.profile.profileId);
    assert.equal(plugProjection.governance.status, governance.profile.status);
    assert.equal(governance.profiles.length, 2);
    assert.equal(governance.profiles[0].status, cpsId === 'cpslai1' ? 'APPROVED' : cpsId === 'cpslai2' ? 'DENIED' : 'PENDING_APPROVAL');
  }

  fs.rmSync(storePath, { force: true });
});

test('Unplug rejects an unregistered CPS clearly', () => {
  const body = executeAcsmUnplug('cpslai999');
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'CPS_NOT_REGISTERED');
});

test('MQTT unplug notification is optional and attempts the existing topic when connected', () => {
  const warnings = [];
  const skipped = publishUnplugNotificationIfAvailable({
    client: null,
    topic: 'acsm1/lifecycle/unplug_request',
    payload: { cpsId: 'cpslai1' },
    onSkipped: (reason) => warnings.push(reason),
  });
  assert.equal(skipped.published, false);
  assert.equal(skipped.skipped, true);
  assert.deepEqual(warnings, ['MQTT_UNPLUG_NOTIFICATION_SKIPPED_CLIENT_UNAVAILABLE']);

  const published = [];
  const result = publishUnplugNotificationIfAvailable({
    client: {
      connected: true,
      publish: (...args) => published.push(args),
    },
    topic: 'acsm1/lifecycle/unplug_request',
    payload: { cpsId: 'cpslai2' },
  });
  assert.deepEqual(result, { published: true, skipped: false });
  assert.equal(published[0][0], 'acsm1/lifecycle/unplug_request');
  assert.deepEqual(JSON.parse(published[0][1]), { cpsId: 'cpslai2' });
  assert.deepEqual(published[0][2], { qos: 1, retain: false });
});
