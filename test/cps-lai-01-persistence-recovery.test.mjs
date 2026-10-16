import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersistentSpool } from '../services/cps-lai-01-persistence/src/spool.js';
import { IngestionService } from '../services/cps-lai-01-persistence/src/ingestion.js';
import { ensureHcmStructure, appendHcmEvent, createHcmEpisode } from '../services/cps-lai-01-persistence/src/hcm.js';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../services/cps-lai-01-persistence/test/fixtures');
const loadOee = async () => JSON.parse(await fs.readFile(path.join(fixtureRoot, 'oee.json'), 'utf8'));
const temporary = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpslai1-persistence-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

test('spool survives process recreation and acknowledges only after repository commit', async () => temporary(async (dir) => {
  const file = path.join(dir, 'pending.jsonl');
  const dead = path.join(dir, 'rejected.jsonl');
  const spool1 = new PersistentSpool(file, dead);
  let fail = true;
  const writes = [];
  const repository = { async persist(record) { if (fail) throw new Error('db unavailable'); writes.push(record); return { duplicate: false }; } };
  const service = new IngestionService({ spool: spool1, repository, now: () => new Date('2026-01-15T12:00:03Z') });
  await service.accept({ topic: 'cpslai1/oee', payload: await loadOee(), qos: 1 });
  await service.drain();
  assert.equal(spool1.size(), 1);
  assert.equal(service.health().databaseError, 'persistence_failed');

  fail = false;
  const spool2 = new PersistentSpool(file, dead);
  await spool2.load();
  const recovered = new IngestionService({ spool: spool2, repository, now: () => new Date('2026-01-15T12:00:04Z') });
  await recovered.drain();
  assert.equal(spool2.size(), 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].projection.calculationState, 'OPERATIONAL_OEE_PROXY');
}));

test('duplicate enqueue after reconnect has one pending copy', async () => temporary(async (dir) => {
  const spool = new PersistentSpool(path.join(dir, 'pending.jsonl'), path.join(dir, 'rejected.jsonl'));
  const repository = { async persist() { return { duplicate: false }; } };
  const service = new IngestionService({ spool, repository });
  const payload = await loadOee();
  const first = await service.accept({ topic: 'cpslai1/oee', payload, qos: 1 });
  const second = await service.accept({ topic: 'cpslai1/oee', payload, qos: 1 });
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(spool.size(), 1);
}));

test('invalid payload is quarantined durably and malformed duplicates are idempotent', async () => temporary(async (dir) => {
  const spool = new PersistentSpool(path.join(dir, 'pending.jsonl'), path.join(dir, 'rejected.jsonl'));
  const service = new IngestionService({ spool, repository: { async persist() {} } });
  await service.accept({ topic: 'cpslai1/oee', payload: '{invalid' });
  await service.accept({ topic: 'cpslai1/oee', payload: '{invalid' });
  const lines = (await fs.readFile(path.join(dir, 'rejected.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(spool.size(), 0);
}));

test('local HCM initializes empty and refuses events for fabricated episodes', async () => temporary(async (dir) => {
  const root = path.join(dir, 'hcm');
  const result = await ensureHcmStructure(root);
  assert.equal(result.createdEpisodes, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'episodes')), []);
  await assert.rejects(appendHcmEvent(root, { eventId: 'e1', episodeId: 'missing', eventType: 'decision' }), /episode must exist/);
  await createHcmEpisode(root, { episodeId: 'ep1', cpsId: 'cpslai1', status: 'open' });
  const eventFile = await appendHcmEvent(root, { eventId: 'e2', episodeId: 'ep1', eventType: 'feedback', occurredAt: '2026-01-15T12:00:00Z' });
  assert.equal((await fs.readFile(eventFile, 'utf8')).trim().split('\n').length, 1);
}));
