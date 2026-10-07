import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CPSLAI1_LIFECYCLE_TOPIC,
  buildCpsLai1LifecyclePayload,
  canTransitionCpsLai1Lifecycle,
  normalizeRegisteredCpsLifecycle,
  shouldPublishCpsLai1Lifecycle,
} from '../lib/acsm/cpsLifecycleMqtt.mjs';

const FIXED_TIMESTAMP = '2026-10-03T12:00:00.000Z';

for (const lifecyclePhase of ['plug', 'play', 'unplug']) {
  test(`${lifecyclePhase} produces the expected cpslai1 lifecycle payload`, () => {
    assert.equal(CPSLAI1_LIFECYCLE_TOPIC, 'acsm/cpslai1/lifecycle');
    assert.deepEqual(buildCpsLai1LifecyclePayload(lifecyclePhase, FIXED_TIMESTAMP), {
      schemaVersion: '1.0',
      cpsId: 'cpslai1',
      lifecyclePhase,
      timestamp: FIXED_TIMESTAMP,
      source: 'ACSM',
    });
    assert.equal(shouldPublishCpsLai1Lifecycle(null, lifecyclePhase), true);
    assert.equal(shouldPublishCpsLai1Lifecycle(lifecyclePhase, lifecyclePhase), false);
  });
}

test('return is legacy history only and is rejected as canonical lifecycle phase', () => {
  assert.equal(buildCpsLai1LifecyclePayload('return', FIXED_TIMESTAMP), null);
  assert.equal(shouldPublishCpsLai1Lifecycle('unplug', 'return'), false);
});

test('maintenance is an operational state and is rejected as lifecycle phase', () => {
  assert.equal(buildCpsLai1LifecyclePayload('maintenance', FIXED_TIMESTAMP), null);
  assert.equal(shouldPublishCpsLai1Lifecycle('play', 'maintenance'), false);
});

test('stop is not a lifecycle phase and is never published', () => {
  assert.equal(buildCpsLai1LifecyclePayload('stop', FIXED_TIMESTAMP), null);
  assert.equal(shouldPublishCpsLai1Lifecycle('play', 'stop'), false);
});

test('RUNNING and STOPPED preserve lifecyclePhase=play without a lifecycle transition', () => {
  for (const operationalState of ['RUNNING', 'STOPPED']) {
    const cps = { lifecyclePhase: 'play', operationalState };

    assert.equal(cps.lifecyclePhase, 'play');
    assert.equal(shouldPublishCpsLai1Lifecycle('play', cps.lifecyclePhase), false);
    assert.equal(
      buildCpsLai1LifecyclePayload(cps.lifecyclePhase, FIXED_TIMESTAMP)?.lifecyclePhase,
      'play'
    );
  }
});

test('play -> unplug publishes unplug and does not collapse directly to plug', () => {
  assert.equal(shouldPublishCpsLai1Lifecycle('play', 'unplug'), true);
  assert.equal(
    buildCpsLai1LifecyclePayload('unplug', FIXED_TIMESTAMP)?.lifecyclePhase,
    'unplug'
  );
  const cps = normalizeRegisteredCpsLifecycle(
    { id: 'cpslai1', lifecyclePhase: 'unplug' },
    { operationallyLinked: false, unplugActive: true }
  );
  assert.equal(cps.lifecyclePhase, 'unplug');
  assert.equal(shouldPublishCpsLai1Lifecycle('unplug', cps.lifecyclePhase), false);
});

test('plug -> play -> unplug -> plug produces the required lifecycle sequence without return', () => {
  assert.equal(canTransitionCpsLai1Lifecycle('plug', 'play'), true);
  assert.equal(canTransitionCpsLai1Lifecycle('play', 'unplug'), true);
  assert.equal(canTransitionCpsLai1Lifecycle('unplug', 'plug'), true);
  assert.equal(buildCpsLai1LifecyclePayload('plug', FIXED_TIMESTAMP)?.lifecyclePhase, 'plug');
  assert.equal(shouldPublishCpsLai1Lifecycle('plug', 'plug'), false);
});

test('plug -> play publishes play', () => {
  assert.equal(shouldPublishCpsLai1Lifecycle('plug', 'play'), true);
  assert.equal(
    buildCpsLai1LifecyclePayload('play', FIXED_TIMESTAMP)?.lifecyclePhase,
    'play'
  );
});

test('canonical priority is unplug, play, then plug', () => {
  const source = { id: 'cpslai1', lifecyclePhase: 'plug' };
  assert.equal(normalizeRegisteredCpsLifecycle(source, {
    unplugActive: true, operationallyLinked: true,
  }).lifecyclePhase, 'unplug');
  assert.equal(normalizeRegisteredCpsLifecycle(source, {
    operationallyLinked: true,
  }).lifecyclePhase, 'play');
  assert.equal(normalizeRegisteredCpsLifecycle(source).lifecyclePhase, 'plug');
});

test('A: status, data or stale Play snapshot cannot promote unplug to play', () => {
  let canonicalPhase = 'plug';
  for (const nextPhase of ['play', 'unplug']) {
    assert.equal(canTransitionCpsLai1Lifecycle(canonicalPhase, nextPhase), true);
    canonicalPhase = nextPhase;
  }

  for (const source of ['status', 'data', 'play-snapshot', 'registration']) {
    assert.equal(
      canTransitionCpsLai1Lifecycle(canonicalPhase, 'play'),
      false,
      `${source} must not promote unplug to play`
    );
    assert.equal(canonicalPhase, 'unplug');
  }
});

test('B: a new Plug is the only canonical path from unplug', () => {
  assert.equal(canTransitionCpsLai1Lifecycle('unplug', 'plug'), true);
  assert.equal(canTransitionCpsLai1Lifecycle('unplug', 'play'), false);
  assert.equal(canTransitionCpsLai1Lifecycle('play', 'plug'), false);
  assert.equal(canTransitionCpsLai1Lifecycle('unplug', 'return'), false);
});

test('C: after the new Plug completes, normal Play is allowed again', () => {
  assert.equal(canTransitionCpsLai1Lifecycle('plug', 'play'), true);
  assert.equal(shouldPublishCpsLai1Lifecycle('plug', 'play'), true);
});

test('registered cpslai1 outside Play is normalized to plug', () => {
  const cps = normalizeRegisteredCpsLifecycle(
    { id: 'cpslai1', lifecyclePhase: 'unplugged' },
    { operationallyLinked: false }
  );

  assert.equal(cps.lifecyclePhase, 'plug');
  assert.equal(cps.lifecycle.currentPhase, 'plug');
});

test('rehydrated cpslai1 ignores stale unplugged and republishes plug', () => {
  const cps = normalizeRegisteredCpsLifecycle(
    { id: 'cpslai1', lifecycle: { currentPhase: 'unplugged' } },
    { operationallyLinked: false, unplugActive: false }
  );

  assert.equal(cps.lifecyclePhase, 'plug');
  assert.equal(shouldPublishCpsLai1Lifecycle('play', cps.lifecyclePhase), true);
  assert.equal(
    buildCpsLai1LifecyclePayload(cps.lifecyclePhase, FIXED_TIMESTAMP)?.lifecyclePhase,
    'plug'
  );
});
