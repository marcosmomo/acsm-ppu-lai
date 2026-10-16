import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PPU_TOPIC, TOPICS, validateMessage } from '../src/contracts.js';
import { normalizeMessage } from '../src/normalize.js';
import { MySqlRepository } from '../src/repository.js';
import { PersistentSpool } from '../src/spool.js';
import { IngestionService } from '../src/ingestion.js';
import { loadConfig } from '../src/config.js';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = async (name) => JSON.parse(await fs.readFile(path.join(fixtureRoot, name), 'utf8'));

function fakePool({ inboxDuplicate = false, ppuDuplicate = false, failPpu = false, historyRows = [] } = {}) {
  const statements = [];
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
    async query(sql) { calls.push(sql); return [[], []]; },
    async execute(sql, args = []) {
      assert.equal((sql.match(/\?/g) || []).length, args.length);
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
      if (/INSERT IGNORE INTO mqtt_inbox/i.test(sql)) return [{ affectedRows: inboxDuplicate ? 0 : 1 }];
      if (/SELECT inbox_id FROM mqtt_inbox/i.test(sql)) return [[{ inbox_id: Buffer.alloc(16, 1) }]];
      if (/INSERT IGNORE INTO ppu_events/i.test(sql)) {
        if (failPpu) throw new Error('controlled database failure');
        return [{ affectedRows: ppuDuplicate ? 0 : 1 }];
      }
      if (/SELECT h\.\* FROM ppu_events/i.test(sql)) return [historyRows, []];
      return [{ affectedRows: 1 }];
    },
  };
  return { statements, calls, async getConnection() { return connection; }, async end() {} };
}

const temporary = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpslai1-ppu-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

test('PPU contract accepts a valid event and rejects invalid, wrong-CPS and retained events', async () => {
  const event = await load('ppu-requested.json');
  assert.equal(validateMessage(PPU_TOPIC, event).ok, true);
  assert.ok(validateMessage(PPU_TOPIC, { ...event, eventId: '' }).errors.includes('invalid_event_id'));
  assert.ok(validateMessage(PPU_TOPIC, { ...event, cpsId: 'cpslai2' }).errors.includes('cps_id_mismatch'));

  await temporary(async (dir) => {
    const spool = new PersistentSpool(path.join(dir, 'pending.jsonl'), path.join(dir, 'rejected.jsonl'));
    const ingestion = new IngestionService({ spool, repository: { async persist() {} } });
    const retained = await ingestion.accept({ topic: PPU_TOPIC, payload: event, retain: true });
    assert.equal(retained.accepted, false);
    assert.deepEqual(retained.errors, ['retained_ppu_event_forbidden']);
  });
});

test('REQUESTED and COMPLETED remain distinct facts with shared correlation and preserved evidence', async () => {
  const requested = normalizeMessage({ topic: PPU_TOPIC, payload: await load('ppu-requested.json') });
  const completed = normalizeMessage({ topic: PPU_TOPIC, payload: await load('ppu-completed.json') });
  assert.equal(requested.projection.eventType, 'PLAY:REQUESTED');
  assert.equal(completed.projection.eventType, 'PLAY:COMPLETED');
  assert.notEqual(requested.projection.eventKey, completed.projection.eventKey);
  assert.equal(requested.projection.correlationId, completed.projection.correlationId);
  assert.deepEqual(completed.projection.evidence.ack, { success: true, reason: 'CONTROLLED_TEST_ACK' });
  assert.equal(completed.record.payload.previousState, 'STOPPED');
  assert.equal(completed.record.payload.newState, 'RUNNING');
});

test('governance decision requires and preserves an explicit human decision', async () => {
  const base = await load('ppu-requested.json');
  const event = {
    ...base,
    eventId: 'ppu-governance-approved-001',
    operation: 'GOVERNANCE_APPROVAL',
    result: 'GOVERNANCE_DECIDED',
    actor: { id: 'human-operator', type: 'HUMAN' },
    humanDecision: { decision: 'APPROVED', decidedBy: 'human-operator', rationale: 'controlled test fixture' },
  };
  assert.equal(validateMessage(PPU_TOPIC, event).ok, true);
  assert.ok(validateMessage(PPU_TOPIC, { ...event, humanDecision: null }).errors.includes('human_decision_required'));
  assert.deepEqual(normalizeMessage({ topic: PPU_TOPIC, payload: event }).record.payload.humanDecision, event.humanDecision);
});

test('transactional writer maps the existing schema and treats stable event-key duplicates safely', async () => {
  const normalized = normalizeMessage({ topic: PPU_TOPIC, payload: await load('ppu-completed.json'), receivedAt: '2026-01-15T12:00:03.000Z' });
  const pool = fakePool();
  const repository = new MySqlRepository(pool);
  const result = await repository.persist(normalized);
  const statement = pool.statements.find(({ sql }) => sql.includes('INSERT IGNORE INTO ppu_events'));
  assert.ok(statement);
  assert.equal(result.ppuDuplicate, false);
  assert.equal(statement.args[1], 'cpslai1');
  assert.equal(statement.args[3], 'PLAY:COMPLETED');
  assert.equal(statement.args[4], 'cpslai1-local-adapter');
  assert.equal(statement.args[5], 'CPS_LOCAL_ADAPTER');
  assert.equal(statement.args[8], 'episode-001');
  assert.equal(statement.args[9], 'ppu-cycle-001');
  assert.deepEqual(JSON.parse(statement.args[10]), normalized.record.payload.evidence);
  assert.deepEqual(JSON.parse(statement.args[11]), normalized.record.payload);
  assert.deepEqual(pool.calls.slice(0, 2), ['begin', 'commit']);

  const duplicatePool = fakePool({ ppuDuplicate: true });
  const duplicate = await new MySqlRepository(duplicatePool).persist(normalized);
  assert.equal(duplicate.ppuDuplicate, true);
  assert.ok(duplicatePool.calls.includes('commit'));
});

test('PPU writer rolls back the inbox transaction when the event insert fails', async () => {
  const pool = fakePool({ failPpu: true });
  const repository = new MySqlRepository(pool);
  await assert.rejects(
    repository.persist(normalizeMessage({ topic: PPU_TOPIC, payload: await load('ppu-completed.json') })),
    /controlled database failure/,
  );
  assert.ok(pool.calls.includes('rollback'));
  assert.ok(!pool.calls.includes('commit'));
  assert.equal(pool.calls.at(-1), 'release');
});

test('PPU failure remains spooled and is recovered after the repository becomes available', async () => temporary(async (dir) => {
  const spoolFile = path.join(dir, 'pending.jsonl');
  const deadFile = path.join(dir, 'rejected.jsonl');
  const event = await load('ppu-completed.json');
  let fail = true;
  const writes = [];
  const repository = { async persist(value) { if (fail) throw new Error('controlled failure'); writes.push(value); return { duplicate: false }; } };
  const firstSpool = new PersistentSpool(spoolFile, deadFile);
  const first = new IngestionService({ spool: firstSpool, repository, now: () => new Date('2026-01-15T12:00:03Z') });
  await first.accept({ topic: PPU_TOPIC, payload: event, qos: 1, retain: false });
  await first.drain();
  assert.equal(firstSpool.size(), 1);

  fail = false;
  const recoveredSpool = new PersistentSpool(spoolFile, deadFile);
  await recoveredSpool.load();
  const recovered = new IngestionService({ spool: recoveredSpool, repository });
  await recovered.drain();
  assert.equal(recoveredSpool.size(), 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].projection.eventType, 'PLAY:COMPLETED');
}));

test('history remains compatible and operational topics remain unchanged', async () => {
  assert.deepEqual(TOPICS, ['cpslai1/data', 'cpslai1/status', 'cpslai1/oee', 'cpslai1/health']);
  assert.equal(loadConfig({}).enablePpuEvents, false);
  assert.equal(loadConfig({ PERSISTENCE_ENABLE_PPU_EVENTS: 'true' }).enablePpuEvents, true);

  const historyRow = { ppu_event_id: Buffer.alloc(16, 2), cps_id: 'cpslai1', event_type: 'PLAY:COMPLETED', recorded_at: new Date('2026-01-15T12:00:03Z') };
  const pool = fakePool({ historyRows: [historyRow] });
  const repository = new MySqlRepository(pool);
  const page = await repository.queryHistory('ppu', { limit: 10 });
  assert.equal(page.count, 1);
  assert.equal(page.items[0].event_type, 'PLAY:COMPLETED');
  const query = pool.statements.find(({ sql }) => sql.startsWith('SELECT h.* FROM ppu_events'));
  assert.ok(query);
  assert.equal(query.args[0], 'cpslai1');
});
