import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { startService } from '../src/index.js';
import { MySqlRepository } from '../src/repository.js';
import { normalizeMessage } from '../src/normalize.js';

const enabled = process.env.CPSLAI1_MYSQL_INTEGRATION === 'true';

test('MySQL 8.4 history API pages a stable snapshot across concurrent inserts', { skip: !enabled }, async () => {
  const mysqlUrl = process.env.MYSQL_URL || '';
  assert.equal(new URL(mysqlUrl).pathname, '/acsm_cpslai1', 'integration target must be the isolated cpslai1 schema');
  const writerPool = mysql.createPool(mysqlUrl, { connectionLimit: 2, timezone: 'Z', multipleStatements: false });
  const [[server]] = await writerPool.query('SELECT VERSION() AS version, DATABASE() AS database_name');
  assert.match(server.version, /^8\.4\./);
  assert.equal(server.database_name, 'acsm_cpslai1');

  const marker = randomUUID();
  const signal = `page-test-${marker}`;
  const at = '2032-04-05T06:07:08.000Z';
  const from = '2032-04-05T06:07:07.000Z';
  const to = '2032-04-05T06:07:09.000Z';
  const writer = new MySqlRepository(writerPool);
  const insert = async (ordinal) => {
    const payload = {
      schemaVersion: '1.0', cpsId: 'cpslai1', source: 'OPC_UA', timestamp: at,
      paginationTestId: marker,
      evidence: { [signal]: {
        value: ordinal, tag: `${marker}-${ordinal}`, nodeId: `test:${marker}:${ordinal}`,
        evidenceStatus: 'FIELD_VALIDATED', timestamp: at, sourceTimestamp: at, serverTimestamp: at,
      } },
    };
    await writer.persist(normalizeMessage({ topic: 'cpslai1/data', payload, receivedAt: new Date() }));
  };

  let shutdown;
  try {
    for (let ordinal = 0; ordinal < 7; ordinal += 1) await insert(ordinal);
    const config = loadConfig({
      ...process.env,
      CPS_ID: 'cpslai1', MYSQL_URL: mysqlUrl, MQTT_URL: 'mqtt://127.0.0.1:1',
      MQTT_CLIENT_ID: `pagination-test-${marker}`, PERSISTENCE_ENABLE_MQTT: 'true',
      PERSISTENCE_RETRY_PERIOD_MS: '3600000', PORT: '32181',
      PERSISTENCE_SPOOL_PATH: `/tmp/${marker}-pending.jsonl`,
      PERSISTENCE_DEAD_LETTER_PATH: `/tmp/${marker}-dead.jsonl`,
    });
    shutdown = await startService(config);

    const url = (params) => `http://127.0.0.1:32181/v1/history/telemetry?${new URLSearchParams(params)}`;
    const filters = { limit: '3', signal, from, to };
    const firstResponse = await fetch(url(filters));
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.count, 3);
    assert.equal(first.limit, 3);
    assert.equal(first.hasMore, true);
    assert.equal(first.items.length, 3);
    assert.deepEqual(first.records, first.items);

    const invalidCursor = await fetch(url({ cursor: randomUUID() }));
    assert.equal(invalidCursor.status, 400);
    const incompatible = await fetch(url({ cursor: first.nextCursor, signal: 'wrong-signal' }));
    assert.equal(incompatible.status, 400);

    // New rows share the timestamp and filters, but belong outside the established InnoDB snapshot.
    await insert(7);
    const secondResponse = await fetch(url({ cursor: first.nextCursor }));
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.count, 3);
    assert.equal(second.hasMore, true);

    const thirdResponse = await fetch(url({ cursor: second.nextCursor, signal, from, to }));
    assert.equal(thirdResponse.status, 200);
    const third = await thirdResponse.json();
    assert.equal(third.count, 1);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);

    const ids = [...first.items, ...second.items, ...third.items]
      .map((record) => Buffer.from(record.sample_id.data).toString('hex'));
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7, 'no item is duplicated across pages');
    const [snapshotRows] = await writerPool.execute(
      `SELECT HEX(t.sample_id) AS id FROM telemetry_samples t
       JOIN mqtt_inbox i ON i.inbox_id=t.inbox_id
       WHERE i.cps_id=? AND JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.paginationTestId'))=?
         AND t.signal_key=? AND t.tag<>? ORDER BY t.sample_timestamp DESC,t.sample_id DESC`,
      ['cpslai1', marker, signal, `${marker}-7`],
    );
    assert.deepEqual(ids, snapshotRows.map((record) => record.id.toLowerCase()));

    const latest = await fetch(url({ limit: '5000', signal, from, to })).then((response) => response.json());
    assert.equal(latest.limit, 1000, 'maximum page size is enforced');
    assert.equal(latest.count, 8, 'new rows appear in a new traversal');
    assert.ok(latest.items.every((record) => record.evidence_status === 'FIELD_VALIDATED'));
  } finally {
    if (shutdown) await shutdown();
    await writerPool.execute(
      `DELETE t FROM telemetry_samples t JOIN mqtt_inbox i ON i.inbox_id=t.inbox_id
       WHERE i.cps_id=? AND JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.paginationTestId'))=?`,
      ['cpslai1', marker],
    );
    await writerPool.execute(
      `DELETE FROM mqtt_inbox WHERE cps_id=? AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.paginationTestId'))=?`,
      ['cpslai1', marker],
    );
    await writer.close();
  }
});
