import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
import mysql from '../../../services/cps-lai-01-persistence/node_modules/mysql2/promise.js';
import { buildPpuEvent } from '../../../lib/acsm/ppuEventBuilder.mjs';
import { publishPendingPpuEvents } from '../../../lib/acsm/ppuMqttPublisher.mjs';
import {
  enqueuePpuOutboxEvent,
  listPpuOutboxEvents,
  ppuOutboxRepository,
} from '../../../services/governance/governanceStore.js';
import { applyMigrations } from '../../../services/cps-lai-01-persistence/src/migrate.js';
import { startService } from '../../../services/cps-lai-01-persistence/src/index.js';

const MQTT_URL = 'mqtt://127.0.0.1:28883';
const MYSQL_URL = 'mysql://ppu_e2e_writer:ppu_e2e_writer_only@127.0.0.1:33307/acsm_cpslai1';
const API_URL = 'http://127.0.0.1:32191';
const mqttOptions = {
  username: 'ppu_e2e_user', password: 'ppu_e2e_only_password', protocolVersion: 5,
  reconnectPeriod: 0, connectTimeout: 3000,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(task, label, attempts = 40) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await task(); } catch (error) { lastError = error; await delay(500); }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`);
}

const connectMqtt = (clientId) => new Promise((resolve, reject) => {
  const client = mqtt.connect(MQTT_URL, { ...mqttOptions, clientId, clean: true });
  const timer = setTimeout(() => { client.end(true); reject(new Error('MQTT test connection timed out.')); }, 5000);
  client.once('connect', () => { clearTimeout(timer); resolve(client); });
  client.once('error', (error) => { clearTimeout(timer); client.end(true); reject(error); });
});

const publishRaw = (client, payload) => new Promise((resolve, reject) => {
  client.publish('cpslai1/ppu/events', JSON.stringify(payload), { qos: 1, retain: false },
    (error) => error ? reject(error) : resolve());
});

const fixture = ({ suffix, operation, result, decision = null }) => buildPpuEvent({
  eventId: `ppu:cpslai1:e2e-isolated:${suffix}`,
  correlationId: 'ppu-e2e-isolated-cycle-001',
  commandId: null,
  cpsId: 'cpslai1', operation, result,
  occurredAt: `2026-10-13T15:0${suffix === 'plug-requested' ? '0' : suffix === 'governance-approved' ? '1' : '2'}:00.000Z`,
  actor: decision ? { id: 'ppu-e2e-fixture-operator', type: 'HUMAN' } : { id: 'ppu-e2e-fixture', type: 'TEST' },
  humanDecision: decision ? {
    decision, decidedBy: 'ppu-e2e-fixture-operator', decidedAt: '2026-10-13T15:01:00.000Z',
  } : null,
  source: 'ACSM_E2E_ISOLATED_TEST',
  evidence: { syntheticFixture: true, environment: 'ppu-e2e-isolated', physicalExecutionClaimed: false },
  episodeId: 'ppu-e2e-isolated-episode-001',
});

const fixtures = [
  fixture({ suffix: 'plug-requested', operation: 'PLUG', result: 'REQUESTED' }),
  fixture({ suffix: 'governance-approved', operation: 'GOVERNANCE_APPROVAL', result: 'GOVERNANCE_DECIDED', decision: 'APPROVED' }),
  fixture({ suffix: 'governance-rejected', operation: 'GOVERNANCE_REJECTION', result: 'GOVERNANCE_DECIDED', decision: 'REJECTED' }),
];

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppu-e2e-isolated-'));
process.env.GOVERNANCE_STORE_PATH = path.join(temporaryDirectory, 'governance-store.test.json');
let shutdownConsumer;
let publisherClient;
let evidencePool;

try {
  await retry(() => applyMigrations({ mysqlUrl: MYSQL_URL }), 'isolated MySQL did not become ready');
  shutdownConsumer = await startService({
    cpsId: 'cpslai1', mqttUrl: MQTT_URL, mqttClientId: `ppu-e2e-consumer-${process.pid}`,
    mqttUsername: mqttOptions.username, mqttPassword: mqttOptions.password, mysqlUrl: MYSQL_URL,
    spoolPath: path.join(temporaryDirectory, 'pending.jsonl'),
    deadLetterPath: path.join(temporaryDirectory, 'rejected.jsonl'),
    sessionExpirySeconds: 60, reconnectPeriodMs: 250, retryPeriodMs: 250,
    maxEvidenceAgeMs: 15000, httpPort: 32191, enableMqtt: true, enablePpuEvents: true,
  });
  await retry(async () => {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) throw new Error(`health=${response.status}`);
  }, 'isolated consumer did not become healthy');

  for (const item of fixtures) enqueuePpuOutboxEvent(item);
  assert.equal(listPpuOutboxEvents().length, 3);
  assert.ok(listPpuOutboxEvents().every((item) => item.status === 'PENDING'));

  let disabledCalls = 0;
  const disabled = await publishPendingPpuEvents({
    client: { publish: () => { disabledCalls += 1; } }, repository: ppuOutboxRepository, enabled: false,
  });
  assert.equal(disabled.published, 0);
  assert.equal(disabledCalls, 0);

  const failed = await publishPendingPpuEvents({
    client: { publish: (_topic, _payload, _options, callback) => callback(new Error('synthetic test outage')) },
    repository: ppuOutboxRepository, enabled: true, retryDelayMs: 0,
  });
  assert.equal(failed.failed, 3);
  assert.ok(listPpuOutboxEvents().every((item) => item.status === 'FAILED' && item.attempts === 1));

  publisherClient = await connectMqtt(`ppu-e2e-publisher-${process.pid}`);
  const published = await publishPendingPpuEvents({
    client: publisherClient, repository: ppuOutboxRepository, enabled: true, retryDelayMs: 0,
    now: new Date(Date.now() + 1000),
  });
  assert.equal(published.published, 3);
  assert.ok(listPpuOutboxEvents().every((item) => item.status === 'PUBLISHED' && item.attempts === 2));

  evidencePool = mysql.createPool(MYSQL_URL, { connectionLimit: 1, timezone: 'Z' });
  const rows = await retry(async () => {
    const [result] = await evidencePool.query(
      'SELECT event_type, correlation_id, payload_json FROM ppu_events ORDER BY occurred_at ASC'
    );
    if (result.length !== 3) throw new Error(`expected 3 rows, found ${result.length}`);
    return result;
  }, 'consumer did not persist all PPU fixtures');

  await publishRaw(publisherClient, fixtures[0]);
  await delay(750);
  const [[counts]] = await evidencePool.query(
    'SELECT COUNT(*) AS ppu_count, (SELECT COUNT(*) FROM mqtt_inbox WHERE topic=?) AS inbox_count FROM ppu_events',
    ['cpslai1/ppu/events']
  );
  assert.equal(Number(counts.ppu_count), 3);
  assert.equal(Number(counts.inbox_count), 3);

  const historyResponse = await fetch(`${API_URL}/v1/history/ppu?limit=10`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.count, 3);
  const historyPayloads = history.records.map((row) => typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json);
  assert.deepEqual(new Set(historyPayloads.map((item) => item.eventId)), new Set(fixtures.map((item) => item.eventId)));
  assert.ok(historyPayloads.every((item) => item.correlationId === 'ppu-e2e-isolated-cycle-001'));

  const summary = {
    environment: 'ppu-e2e-isolated', syntheticFixtures: true, physicalValidation: false,
    endpoints: { mqtt: MQTT_URL, mysql: '127.0.0.1:33307/acsm_cpslai1', api: API_URL },
    outbox: listPpuOutboxEvents().map(({ eventId, status, attempts }) => ({ eventId, status, attempts })),
    mysql: rows.map((row) => ({
      eventType: row.event_type, correlationId: row.correlation_id,
      eventId: (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json).eventId,
    })),
    history: { status: historyResponse.status, count: history.count, eventIds: historyPayloads.map((item) => item.eventId) },
    deduplication: { ppuRowsAfterReplay: Number(counts.ppu_count), inboxRowsAfterReplay: Number(counts.inbox_count) },
    disabledPublisherCalls: disabledCalls,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  if (evidencePool) await evidencePool.end().catch(() => {});
  if (publisherClient) await new Promise((resolve) => publisherClient.end(false, {}, resolve));
  if (shutdownConsumer) await shutdownConsumer().catch(() => {});
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  delete process.env.GOVERNANCE_STORE_PATH;
}
