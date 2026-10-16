import test from 'node:test';
import assert from 'node:assert/strict';
import { MySqlRepository } from '../services/cps-lai-01-persistence/src/repository.js';

const binaryId = (value) => {
  const id = Buffer.alloc(16);
  id.writeUInt32BE(value, 12);
  return id;
};
const row = (id, timestamp = new Date('2026-05-01T12:00:00.000Z')) => ({
  sample_id: binaryId(id), sample_timestamp: timestamp,
  signal_key: 'pagination-test', evidence_status: 'FIELD_VALIDATED', raw_value_json: { ordinal: id },
});

function fakeHistoryPool(responses, { onStart } = {}) {
  const executions = [];
  const calls = [];
  const connection = {
    async query(sql) {
      if (sql.includes('START TRANSACTION')) onStart?.();
      calls.push({ sql, params: [] });
      return [[], []];
    },
    async execute(sql, params) {
      executions.push({ sql, params });
      const placeholders = (sql.match(/\?/g) || []).length;
      assert.equal(placeholders, params.length, 'all dynamic query values use SQL placeholders');
      return [responses.shift() ?? [], []];
    },
    async commit() {}, async rollback() {}, release() {},
  };
  return {
    executions, calls,
    async getConnection() { return connection; },
    async end() {},
  };
}

test('keyset cursor traverses equal timestamps in stable timestamp + primary-key order', async () => {
  const pool = fakeHistoryPool([[row(5), row(4), row(3)], [row(3), row(2), row(1)], [row(1)]]);
  const repository = new MySqlRepository(pool);
  try {
    const first = await repository.queryHistory('telemetry', { limit: 2, signal: 'pagination-test' });
    assert.deepEqual(first.items.map((item) => item.sample_id.readUInt32BE(12)), [5, 4]);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    assert.equal(first.count, 2);
    assert.equal(first.items[0].evidence_status, 'FIELD_VALIDATED');
    assert.deepEqual(first.items[0].raw_value_json, { ordinal: 5 });

    const second = await repository.queryHistory('telemetry', { cursor: first.nextCursor });
    assert.deepEqual(second.items.map((item) => item.sample_id.readUInt32BE(12)), [3, 2]);
    assert.equal(second.hasMore, true);
    assert.ok(second.nextCursor);

    const third = await repository.queryHistory('telemetry', { cursor: second.nextCursor });
    assert.deepEqual(third.items.map((item) => item.sample_id.readUInt32BE(12)), [1]);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.sample_id.readUInt32BE(12));
    assert.deepEqual(ids, [5, 4, 3, 2, 1]);
    assert.equal(new Set(ids).size, ids.length);

    const sql = pool.executions[0].sql;
    assert.match(sql, /i\.cps_id = \?/);
    assert.match(sql, /ORDER BY \(t\.sample_timestamp IS NULL\) ASC, t\.sample_timestamp DESC, t\.sample_id DESC/);
    assert.match(sql, /t\.signal_key = \?/);
    assert.equal(pool.executions[0].params[0], 'cpslai1');
    assert.equal(pool.executions[0].params.includes('pagination-test'), true);
    assert.match(pool.executions[1].sql, /t\.sample_timestamp < \? OR \(t\.sample_timestamp = \? AND t\.sample_id < \?\)/);
  } finally { await repository.close(); }
});

test('cursor is bound to kind and filters; malformed, incompatible and expired cursors return HTTP-ready 400 errors', async () => {
  const pool = fakeHistoryPool([[row(3), row(2)], [row(3), row(2)], [row(3), row(2)]]);
  const repository = new MySqlRepository(pool, { historyCursorTtlMs: 50 });
  try {
    await assert.rejects(repository.queryHistory('telemetry', { cursor: 'bad' }), (error) => error.statusCode === 400);
    const page = await repository.queryHistory('telemetry', { limit: 1, signal: 'pagination-test' });
    await assert.rejects(
      repository.queryHistory('telemetry', { cursor: page.nextCursor, signal: 'different-signal' }),
      (error) => error.statusCode === 400 && /incompatible/.test(error.message),
    );
    await assert.rejects(
      repository.queryHistory('oee', { cursor: page.nextCursor }),
      (error) => error.statusCode === 400 && /incompatible/.test(error.message),
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    await assert.rejects(
      repository.queryHistory('telemetry', { cursor: page.nextCursor }),
      (error) => error.statusCode === 400 && /expired/.test(error.message),
    );
  } finally { await repository.close(); }
});

test('page size is capped at 1000 and legacy offset remains parameterized', async () => {
  const pool = fakeHistoryPool([[row(1)], [row(1)]]);
  const repository = new MySqlRepository(pool);
  try {
    const capped = await repository.queryHistory('telemetry', { limit: 5000 });
    assert.equal(capped.limit, 1000);
    assert.equal(pool.executions[0].params.at(-1), 1001);
    const offset = await repository.queryHistory('telemetry', { limit: 5, offset: 3 });
    assert.equal(offset.limit, 5);
    assert.match(pool.executions[1].sql, /LIMIT \? OFFSET \?/);
    assert.deepEqual(pool.executions[1].params.slice(-2), [6, 3]);
  } finally { await repository.close(); }
});

test('invalid date/limit filters are rejected before issuing SQL', async () => {
  const pool = fakeHistoryPool([]);
  const repository = new MySqlRepository(pool);
  try {
    await assert.rejects(repository.queryHistory('telemetry', { from: 'not-a-date' }), (error) => error.statusCode === 400);
    await assert.rejects(repository.queryHistory('telemetry', { limit: 0 }), (error) => error.statusCode === 400);
    await assert.rejects(repository.queryHistory('oee', { signal: 'not-applicable' }), (error) => error.statusCode === 400);
    assert.equal(pool.executions.length, 0);
  } finally { await repository.close(); }
});
