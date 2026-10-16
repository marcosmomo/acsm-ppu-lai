import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../lib/evolution/aasArchive.mjs';
import { resolveCompleteAas } from '../lib/evolution/aasResolver.mjs';
import { createStaticAasFileSource, CPS_LAI_STATIC_AAS_MANIFEST } from '../lib/evolution/staticAasFileSource.mjs';
import { EvolutionStore } from '../lib/evolution/evolutionStore.mjs';
import { coordinateAcceptedPlugEvolution } from '../lib/evolution/evolutionCoordinator.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aasRoot = path.join(projectRoot, 'cps-defs');

async function temporary(run) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-aas-archive-'));
  try { return await run(rootDir); }
  finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
}

const readSourceBytes = (number) => fs.readFileSync(path.join(aasRoot,
  `cps-lai-0${number}-aas-acsm-compatible-revised.json`));

test('archives and retrieves exact source bytes for all three static AAS documents', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir: path.join(rootDir, 'objects') });
  const source = createStaticAasFileSource({ rootDir: aasRoot, entries: CPS_LAI_STATIC_AAS_MANIFEST });
  for (const number of [1, 2, 3]) {
    const suppliedBytes = readSourceBytes(number);
    const resolved = await resolveCompleteAas({ cpsId: `cpslai${number}`, source, archive });
    assert.deepEqual(resolved.rawBytes, suppliedBytes);
    assert.equal(resolved.integrity.contentHash, resolved.archiveReference.contentHash);
    assert.equal(resolved.resolvedReference.archiveReference, `sha256:${resolved.integrity.contentHash}`);
    assert.deepEqual(await archive.getByHash(resolved.integrity.contentHash), suppliedBytes);
    assert.equal(resolved.provenance.sourceType, 'STATIC_FILE');
    assert.equal(resolved.provenance.operational, false);
  }
}));

test('same bytes reuse one immutable object and changed bytes get a new address', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir });
  const bytes = Buffer.from('{ "aas": 1 }\n');
  const first = await archive.archive({ bytes });
  const again = await archive.archive({ bytes, expectedHash: first.contentHash });
  const changed = await archive.archive({ bytes: Buffer.from('{"aas":2}\n') });
  assert.equal(first.contentHash, again.contentHash);
  assert.equal(again.reused, true);
  assert.notEqual(changed.contentHash, first.contentHash);
  assert.equal([first, changed].every((item) => fs.existsSync(path.join(rootDir, item.contentHash.slice(0, 2), `${item.contentHash}.aas`))), true);
  assert.notEqual(first.contentHash.slice(0, 2), changed.contentHash.slice(0, 2));
}));

test('rejects missing, malformed and corrupt archive references without fallback', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir });
  await assert.rejects(archive.getByHash('f'.repeat(64)), (error) => error.code === 'AAS_ARCHIVE_NOT_FOUND');
  await assert.rejects(archive.getByHash('not-a-hash'), (error) => error.code === 'AAS_ARCHIVE_HASH_INVALID');
  const saved = await archive.archive({ bytes: Buffer.from('original') });
  const objectPath = path.join(rootDir, saved.contentHash.slice(0, 2), `${saved.contentHash}.aas`);
  fs.writeFileSync(objectPath, 'corrupt');
  await assert.rejects(archive.getByHash(saved.contentHash), (error) => error.code === 'AAS_ARCHIVE_CORRUPT');
  await assert.rejects(archive.archive({ bytes: Buffer.from('original') }), (error) => error.code === 'AAS_ARCHIVE_CONTENT_CONFLICT');
}));

test('write failure leaves no published object and does not damage a prior object', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir, beforePublish() { throw Object.assign(new Error('controlled'), { code: 'CONTROLLED_WRITE_FAILURE' }); } });
  await assert.rejects(archive.archive({ bytes: Buffer.from('new document') }), (error) => error.code === 'CONTROLLED_WRITE_FAILURE');
  const entries = fs.existsSync(rootDir) ? fs.readdirSync(rootDir, { recursive: true }) : [];
  assert.equal(entries.some((entry) => String(entry).endsWith('.aas')), false);
}));

test('concurrent duplicate archival is idempotent and preserves the original bytes', async () => temporary(async (rootDir) => {
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const archive = new AasArchive({ rootDir, async beforePublish() {
    arrivals += 1;
    if (arrivals === 2) release();
    await barrier;
  } });
  const bytes = Buffer.from('same bytes');
  const results = await Promise.all(Array.from({ length: 8 }, () => archive.archive({ bytes })));
  assert.equal(new Set(results.map((item) => item.contentHash)).size, 1);
  assert.deepEqual(await archive.getByHash(results[0].contentHash), bytes);
  assert.equal(fs.readdirSync(path.join(rootDir, results[0].contentHash.slice(0, 2))).filter((name) => name.endsWith('.aas')).length, 1);
}));

test('Evolution snapshot and comparison retain the exact archived AAS reference across store restart', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir: path.join(rootDir, 'archive') });
  const storePath = path.join(rootDir, 'store.json');
  const source = createStaticAasFileSource({ rootDir: aasRoot, entries: CPS_LAI_STATIC_AAS_MANIFEST });
  const resolved = await resolveCompleteAas({ cpsId: 'cpslai1', source, archive });
  const report = await coordinateAcceptedPlugEvolution({
    cpsId: 'cpslai1', plugEventId: 'fixture-plug-01', plugCycleId: 'fixture-cycle-01',
    resolvedAas: resolved, store: new EvolutionStore({ filePath: storePath }), plugAccepted: true,
  });
  const restarted = new EvolutionStore({ filePath: storePath });
  const history = await restarted.listComparisons({ cpsId: 'cpslai1' });
  const stored = (await restarted.inspect()).snapshots[report.snapshotId];
  assert.equal(stored.aasReference.contentHash, resolved.integrity.contentHash);
  assert.equal(stored.aasReference.archiveReference, `sha256:${resolved.integrity.contentHash}`);
  assert.equal(stored.aasReference.sourceType, 'STATIC_FILE');
  assert.equal(stored.aasReference.physicalStateInferred, false);
  assert.equal(stored.plugEventId, 'fixture-plug-01');
  assert.equal(stored.plugCycleId, 'fixture-cycle-01');
  assert.equal(history[0].aasReference.contentHash, stored.aasReference.contentHash);
  assert.deepEqual(await archive.getByHash(stored.aasReference.contentHash), resolved.rawBytes);
}));

test('same Plug event remains idempotent when the exact AAS is resolved again later', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir: path.join(rootDir, 'archive') });
  const store = new EvolutionStore({ filePath: path.join(rootDir, 'store.json') });
  const source = createStaticAasFileSource({ rootDir: aasRoot, entries: CPS_LAI_STATIC_AAS_MANIFEST });
  const firstAas = await resolveCompleteAas({ cpsId: 'cpslai3', source, archive, now: () => new Date('2026-10-13T10:00:00Z') });
  const first = await coordinateAcceptedPlugEvolution({
    cpsId: 'cpslai3', plugEventId: 'same-plug', plugCycleId: 'same-cycle', resolvedAas: firstAas, store, plugAccepted: true,
  });
  const secondAas = await resolveCompleteAas({ cpsId: 'cpslai3', source, archive, now: () => new Date('2026-10-13T11:00:00Z') });
  const retry = await coordinateAcceptedPlugEvolution({
    cpsId: 'cpslai3', plugEventId: 'same-plug', plugCycleId: 'same-cycle', resolvedAas: secondAas, store, plugAccepted: true,
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.snapshotId, first.snapshotId);
  assert.equal((await store.listComparisons()).length, 1);
}));

test('archive remains reusable when Evolution Store fails after archival', async () => temporary(async (rootDir) => {
  const archive = new AasArchive({ rootDir: path.join(rootDir, 'archive') });
  const source = createStaticAasFileSource({ rootDir: aasRoot, entries: CPS_LAI_STATIC_AAS_MANIFEST });
  const resolved = await resolveCompleteAas({ cpsId: 'cpslai2', source, archive });
  const failingStore = new EvolutionStore({
    filePath: path.join(rootDir, 'store.json'),
    beforeRename() { throw Object.assign(new Error('controlled store failure'), { code: 'CONTROLLED_STORE_FAILURE' }); },
  });
  await assert.rejects(coordinateAcceptedPlugEvolution({
    cpsId: 'cpslai2', plugEventId: 'fixture-plug-fail', plugCycleId: 'fixture-cycle-fail',
    resolvedAas: resolved, store: failingStore, plugAccepted: true,
  }), (error) => error.code === 'CONTROLLED_STORE_FAILURE');
  assert.deepEqual(await archive.getByHash(resolved.integrity.contentHash), resolved.rawBytes);
  assert.equal(fs.existsSync(path.join(rootDir, 'store.json')), false);
}));
