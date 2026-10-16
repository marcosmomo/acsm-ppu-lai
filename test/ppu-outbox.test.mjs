import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPpuEvent } from '../lib/acsm/ppuEventBuilder.mjs';
import {
  enqueuePpuOutbox,
  markPpuOutboxFailed,
  markPpuOutboxPublished,
} from '../lib/acsm/ppuOutbox.mjs';
import {
  isPpuMqttPublishingEnabled,
  publishPendingPpuEvents,
} from '../lib/acsm/ppuMqttPublisher.mjs';
import {
  enqueuePpuOutboxEvent,
  listPpuOutboxEvents,
} from '../services/governance/governanceStore.js';

const event = (overrides = {}) => buildPpuEvent({
  eventId: 'ppu:cpslai1:plug:test:requested',
  correlationId: 'cpslai1-plug-v1',
  cpsId: 'cpslai1',
  operation: 'PLUG',
  result: 'REQUESTED',
  occurredAt: '2026-10-13T12:00:00.000Z',
  source: 'ACSM',
  evidence: { plugEventId: 'plug-test' },
  ...overrides,
});

const memoryRepository = (initial) => {
  const store = { ppuOutbox: {} };
  enqueuePpuOutbox(store, initial, { now: '2026-10-13T12:00:00.000Z' });
  return {
    store,
    repository: {
      list: () => Object.values(store.ppuOutbox),
      markPublished: (id, options) => markPpuOutboxPublished(store, id, options),
      markFailed: (id, error, options) => markPpuOutboxFailed(store, id, error, options),
    },
  };
};

test('persists an event and recovers it through a new store read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-ppu-outbox-'));
  const previous = process.env.GOVERNANCE_STORE_PATH;
  process.env.GOVERNANCE_STORE_PATH = path.join(directory, 'governance.json');
  try {
    const first = enqueuePpuOutboxEvent(event());
    assert.equal(first.duplicate, false);
    const recovered = listPpuOutboxEvents();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'PENDING');
    assert.equal(recovered[0].payload.correlationId, 'cpslai1-plug-v1');
  } finally {
    if (previous === undefined) delete process.env.GOVERNANCE_STORE_PATH;
    else process.env.GOVERNANCE_STORE_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deduplicates identical eventId and rejects a conflicting payload', () => {
  const store = { ppuOutbox: {} };
  assert.equal(enqueuePpuOutbox(store, event()).duplicate, false);
  assert.equal(enqueuePpuOutbox(store, event()).duplicate, true);
  assert.throws(
    () => enqueuePpuOutbox(store, event({ correlationId: 'different' })),
    { code: 'PPU_OUTBOX_EVENT_CONFLICT' }
  );
  assert.equal(Object.keys(store.ppuOutbox).length, 1);
});

test('rejects invalid envelopes and exposes a storage failure', () => {
  assert.throws(() => enqueuePpuOutbox({ ppuOutbox: {} }, { eventId: 'invalid' }), { code: 'INVALID_PPU_EVENT' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-ppu-outbox-fail-'));
  const previous = process.env.GOVERNANCE_STORE_PATH;
  process.env.GOVERNANCE_STORE_PATH = directory;
  try {
    assert.throws(() => enqueuePpuOutboxEvent(event()));
  } finally {
    if (previous === undefined) delete process.env.GOVERNANCE_STORE_PATH;
    else process.env.GOVERNANCE_STORE_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publisher is disabled by default and performs no MQTT call', async () => {
  const calls = [];
  const { repository } = memoryRepository(event());
  assert.equal(isPpuMqttPublishingEnabled({}), false);
  const result = await publishPendingPpuEvents({
    client: { publish: (...args) => calls.push(args) }, repository, enabled: false,
  });
  assert.deepEqual(result, { enabled: false, attempted: 0, published: 0, failed: 0 });
  assert.equal(calls.length, 0);
});

test('publisher uses the historical topic, QoS 1, retain false and preserves payload', async () => {
  const calls = [];
  const original = event();
  const { store, repository } = memoryRepository(original);
  const client = {
    publish(topic, payload, options, callback) {
      calls.push({ topic, payload: JSON.parse(payload), options });
      callback(null);
    },
  };
  const result = await publishPendingPpuEvents({ client, repository, enabled: true, now: new Date('2026-10-13T12:01:00Z') });
  assert.equal(result.published, 1);
  assert.equal(calls[0].topic, 'cpslai1/ppu/events');
  assert.deepEqual(calls[0].options, { qos: 1, retain: false });
  assert.deepEqual(calls[0].payload, original);
  assert.equal(calls[0].payload.correlationId, 'cpslai1-plug-v1');
  assert.equal(store.ppuOutbox[original.eventId].status, 'PUBLISHED');
});

test('publication failure is durable, sanitized and retryable when due', async () => {
  const original = event({
    eventId: 'ppu:cpslai1:governance:test:approved',
    operation: 'GOVERNANCE_APPROVAL',
    result: 'GOVERNANCE_DECIDED',
    actor: { id: 'operator', type: 'HUMAN' },
    humanDecision: { decision: 'APPROVED', decidedBy: 'operator', decidedAt: '2026-10-13T12:00:00.000Z' },
  });
  const { store, repository } = memoryRepository(original);
  let fail = true;
  const client = { publish(_topic, _payload, _options, callback) {
    callback(fail ? new Error('mqtt://user:password@broker password=visible') : null);
  } };
  const first = await publishPendingPpuEvents({ client, repository, enabled: true, now: new Date('2026-10-13T12:01:00Z'), retryDelayMs: 1000 });
  assert.equal(first.failed, 1);
  assert.equal(store.ppuOutbox[original.eventId].status, 'FAILED');
  assert.doesNotMatch(JSON.stringify(store.ppuOutbox[original.eventId].lastError), /password@|visible/);

  fail = false;
  const second = await publishPendingPpuEvents({ client, repository, enabled: true, now: new Date('2026-10-13T12:01:02Z'), retryDelayMs: 1000 });
  assert.equal(second.published, 1);
  assert.equal(store.ppuOutbox[original.eventId].status, 'PUBLISHED');
  assert.equal(store.ppuOutbox[original.eventId].attempts, 2);
});

test('supports rejection events without confusing them with an operation completion', () => {
  const rejection = event({
    eventId: 'ppu:cpslai1:governance:test:rejected',
    operation: 'GOVERNANCE_REJECTION',
    result: 'GOVERNANCE_DECIDED',
    actor: { id: 'operator', type: 'HUMAN' },
    humanDecision: { decision: 'REJECTED', decidedBy: 'operator', decidedAt: '2026-10-13T12:00:00.000Z' },
  });
  const store = { ppuOutbox: {} };
  const queued = enqueuePpuOutbox(store, rejection).entry;
  assert.equal(queued.payload.operation, 'GOVERNANCE_REJECTION');
  assert.equal(queued.payload.result, 'GOVERNANCE_DECIDED');
  assert.notEqual(queued.payload.result, 'COMPLETED');
});
