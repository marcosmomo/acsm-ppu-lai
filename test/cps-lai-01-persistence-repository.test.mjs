import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MySqlRepository } from '../services/cps-lai-01-persistence/src/repository.js';
import { normalizeMessage } from '../services/cps-lai-01-persistence/src/normalize.js';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../services/cps-lai-01-persistence/test/fixtures');
const load = async (name) => JSON.parse(await fs.readFile(path.join(fixtureRoot, name), 'utf8'));

function fakePool({ duplicate = false, latestState = null, priorExit = null } = {}) {
  const statements = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, args = []) {
      const placeholders = (sql.match(/\?/g) || []).length;
      if (placeholders !== args.length) throw new Error(`SQL placeholder mismatch (${placeholders} placeholders, ${args.length} values).`);
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (/INSERT IGNORE INTO mqtt_inbox/i.test(sql)) return [{ affectedRows: duplicate ? 0 : 1 }];
      if (/SELECT inbox_id FROM mqtt_inbox/i.test(sql)) return [[{ inbox_id: Buffer.alloc(16, 1) }]];
      if (/SELECT operational_state, started_at/i.test(sql)) return [[...(latestState ? [latestState] : [])]];
      if (/SELECT sample_id FROM telemetry_samples/i.test(sql)) return [[]];
      if (/SELECT value_bool, sample_timestamp FROM telemetry_samples/i.test(sql)) return [[...(priorExit ? [priorExit] : [])]];
      return [{ affectedRows: 1 }];
    },
  };
  return { statements, getConnection: async () => connection };
}

test('OEE snapshots preserve counters without manufacturing production events', async () => {
  const pool = fakePool();
  const repo = new MySqlRepository(pool);
  await repo.persist(normalizeMessage({ topic: 'cpslai1/oee', payload: await load('oee.json') }));
  assert.ok(pool.statements.some((sql) => sql.includes('INSERT INTO oee_snapshots')));
  assert.ok(!pool.statements.some((sql) => sql.includes('INSERT IGNORE INTO production_events')));
});

test('validated PieceAtExit rising edge creates one idempotent physical production event', async () => {
  const data = await load('data.json');
  data.evidence.PieceAtExit.value = true;
  const pool = fakePool({ priorExit: { value_bool: 0, sample_timestamp: new Date('2026-01-15T12:00:01Z') } });
  const repo = new MySqlRepository(pool);
  await repo.persist(normalizeMessage({ topic: 'cpslai1/data', payload: data, receivedAt: '2026-01-15T12:00:03.000Z' }));
  assert.equal(pool.statements.filter((sql) => sql.includes('INSERT IGNORE INTO production_events')).length, 1);
});

test('out-of-order operational state is retained in inbox but does not create a false transition', async () => {
  const status = await load('status.json');
  const pool = fakePool({ latestState: { operational_state: 'STOPPED', started_at: new Date('2026-01-15T12:00:05Z') } });
  const repo = new MySqlRepository(pool);
  await repo.persist(normalizeMessage({ topic: 'cpslai1/status', payload: status }));
  assert.ok(pool.statements.some((sql) => sql.includes('INSERT IGNORE INTO mqtt_inbox')));
  assert.ok(!pool.statements.some((sql) => sql.includes('INSERT INTO operational_state_events')));
});

test('database-level duplicate inbox identity skips all projections', async () => {
  const pool = fakePool({ duplicate: true });
  const repo = new MySqlRepository(pool);
  const result = await repo.persist(normalizeMessage({ topic: 'cpslai1/oee', payload: await load('oee.json') }));
  assert.equal(result.duplicate, true);
  assert.equal(pool.statements.length, 1);
});
