import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCompleteAas } from '../lib/evolution/aasResolver.mjs';
import { createStaticAasFileSource, CPS_LAI_STATIC_AAS_MANIFEST } from '../lib/evolution/staticAasFileSource.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = path.join(root, 'cps-defs');
const fixedNow = () => new Date('2026-10-13T15:00:00.000Z');
const load = (number) => JSON.parse(fs.readFileSync(
  path.join(definitions, `cps-lai-0${number}-aas-acsm-compatible-revised.json`), 'utf8'));

const productionStaticSource = () => createStaticAasFileSource({
  rootDir: definitions,
  entries: CPS_LAI_STATIC_AAS_MANIFEST,
});
async function temporary(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-aas-resolver-'));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('resolves all three CPS-LAI documents with identity, provenance and integrity', async () => {
  for (const number of [1, 2, 3]) {
    const resolved = await resolveCompleteAas({
      cpsId: `CPS-LAI-0${number}`,
      source: productionStaticSource(),
      now: fixedNow,
    });
    assert.equal(resolved.identity.cpsId, `cpslai${number}`);
    assert.match(resolved.identity.aasId, new RegExp(`cps-lai-0${number}:aas$`));
    assert.match(resolved.identity.assetId, new RegExp(`cps-lai-0${number}`));
    assert.equal(resolved.provenance.sourceType, 'STATIC_FILE');
    assert.equal(resolved.provenance.operational, false);
    assert.equal(resolved.provenance.sourceRevision, 'repository-current');
    assert.equal(resolved.resolvedAt, '2026-10-13T15:00:00.000Z');
    assert.equal(resolved.integrity.contentHash.length, 64);
    assert.equal(resolved.physicalStateInferred, false);
  }
});

test('rejects a document whose CPS identity differs from the request', async () => temporary(async (directory) => {
  fs.copyFileSync(path.join(definitions, 'cps-lai-03-aas-acsm-compatible-revised.json'), path.join(directory, 'wrong.json'));
  const source = createStaticAasFileSource({ rootDir: directory, entries: { cpslai1: 'wrong.json' } });
  await assert.rejects(resolveCompleteAas({ cpsId: 'cpslai1', source }), (error) => error.code === 'AAS_CPS_ID_MISMATCH');
}));

test('rejects absent and malformed configured documents explicitly', async () => temporary(async (directory) => {
  const absent = createStaticAasFileSource({ rootDir: directory, entries: { cpslai1: 'missing.json' } });
  await assert.rejects(resolveCompleteAas({ cpsId: 'cpslai1', source: absent }), (error) => error.code === 'AAS_SOURCE_DOCUMENT_NOT_FOUND');

  fs.writeFileSync(path.join(directory, 'malformed.json'), '{not-json', 'utf8');
  const malformed = createStaticAasFileSource({ rootDir: directory, entries: { cpslai1: 'malformed.json' } });
  await assert.rejects(resolveCompleteAas({ cpsId: 'cpslai1', source: malformed }), (error) => error.code === 'AAS_SOURCE_DOCUMENT_MALFORMED');
}));

test('returns partial AAS explicitly or rejects it under strict completeness policy', async () => temporary(async (directory) => {
  const partial = load(1);
  partial.submodels = partial.submodels.filter((item) => item.idShort !== 'Capabilities');
  fs.writeFileSync(path.join(directory, 'partial.json'), JSON.stringify(partial), 'utf8');
  const source = createStaticAasFileSource({ rootDir: directory, entries: { cpslai1: 'partial.json' } });
  const resolved = await resolveCompleteAas({ cpsId: 'cpslai1', source });
  assert.equal(resolved.completeness, 'INCOMPLETE');
  assert.equal(resolved.pendingValidation.some((item) => item.code === 'CAPABILITIES_SUBMODEL_MISSING'), true);
  await assert.rejects(
    resolveCompleteAas({ cpsId: 'cpslai1', source, policy: { requireFunctionalCompleteness: true } }),
    (error) => error.code === 'AAS_FUNCTIONALLY_INCOMPLETE',
  );
}));

test('content and canonical hashes are deterministic for an unchanged exact document', async () => {
  const source = productionStaticSource();
  const first = await resolveCompleteAas({ cpsId: 'cpslai2', source, now: fixedNow });
  const second = await resolveCompleteAas({ cpsId: 'cpslai2', source, now: fixedNow });
  assert.deepEqual(first.integrity, second.integrity);
  assert.deepEqual(first.resolvedReference, second.resolvedReference);
});

test('detects changed document content and refuses an obsolete exact hash reference', async () => temporary(async (directory) => {
  const original = load(1);
  const changed = structuredClone(original);
  changed.submodels.find((item) => item.idShort === 'Capabilities').submodelElements
    .find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  fs.writeFileSync(path.join(directory, 'v1.json'), JSON.stringify(original), 'utf8');
  fs.writeFileSync(path.join(directory, 'v2.json'), JSON.stringify(changed), 'utf8');
  const sourceV1 = createStaticAasFileSource({ rootDir: directory, entries: { cpslai1: 'v1.json' } });
  const sourceV2 = createStaticAasFileSource({ rootDir: directory, entries: { cpslai1: 'v2.json' } });
  const v1 = await resolveCompleteAas({ cpsId: 'cpslai1', source: sourceV1 });
  const v2 = await resolveCompleteAas({ cpsId: 'cpslai1', source: sourceV2 });
  assert.notEqual(v1.integrity.contentHash, v2.integrity.contentHash);
  assert.notEqual(v1.integrity.canonicalHash, v2.integrity.canonicalHash);
  await assert.rejects(
    resolveCompleteAas({ cpsId: 'cpslai1', source: sourceV2, expectedReference: { contentHash: v1.integrity.contentHash } }),
    (error) => error.code === 'AAS_EXPECTED_REFERENCE_MISMATCH',
  );
}));

test('resolves two explicitly configured functional versions for the same CPS without fallback', async () => temporary(async (directory) => {
  const v1 = load(3);
  const v2 = structuredClone(v1);
  v2.submodels.find((item) => item.idShort === 'Capabilities').submodelElements.push({
    modelType: 'Property', idShort: 'AdaptiveRouting', valueType: 'xs:boolean', value: 'true',
  });
  fs.writeFileSync(path.join(directory, 'v1.json'), JSON.stringify(v1), 'utf8');
  fs.writeFileSync(path.join(directory, 'v2.json'), JSON.stringify(v2), 'utf8');
  const source = createStaticAasFileSource({
    rootDir: directory,
    entries: { cpslai3: { file: 'v2.json', revision: 'v2', versions: { v1: 'v1.json', v2: 'v2.json' } } },
  });
  const first = await resolveCompleteAas({ cpsId: 'cpslai3', source, expectedReference: { sourceRevision: 'v1' } });
  const second = await resolveCompleteAas({ cpsId: 'cpslai3', source, expectedReference: { sourceRevision: 'v2' } });
  assert.notEqual(first.integrity.contentHash, second.integrity.contentHash);
  assert.equal(first.provenance.sourceRevision, 'v1');
  assert.equal(second.provenance.sourceRevision, 'v2');
  await assert.rejects(
    resolveCompleteAas({ cpsId: 'cpslai3', source, expectedReference: { sourceRevision: 'missing' } }),
    (error) => error.code === 'AAS_SOURCE_REVISION_NOT_FOUND',
  );
}));

test('static development source is never represented as an operational source', async () => {
  const source = productionStaticSource();
  const resolved = await resolveCompleteAas({ cpsId: 'cpslai1', source });
  assert.equal(resolved.provenance.operational, false);
  assert.equal(resolved.evidenceScope, 'STATIC_DOCUMENT_DECLARATION');
  await assert.rejects(
    resolveCompleteAas({ cpsId: 'cpslai1', source, policy: { requireOperationalSource: true } }),
    (error) => error.code === 'AAS_OPERATIONAL_SOURCE_REQUIRED',
  );
});

test('expected AAS and asset identities are enforced', async () => {
  const source = productionStaticSource();
  const resolved = await resolveCompleteAas({ cpsId: 'cpslai1', source });
  const exact = await resolveCompleteAas({
    cpsId: 'cpslai1', source,
    expectedReference: {
      aasId: resolved.identity.aasId,
      assetId: resolved.identity.assetId,
      version: resolved.identity.version,
      revision: resolved.identity.revision,
      contentHash: resolved.integrity.contentHash,
    },
  });
  assert.equal(exact.integrity.contentHash, resolved.integrity.contentHash);
  await assert.rejects(
    resolveCompleteAas({ cpsId: 'cpslai1', source, expectedReference: { aasId: 'urn:wrong:aas' } }),
    (error) => error.code === 'AAS_EXPECTED_REFERENCE_MISMATCH',
  );
});

test('resolver and static source have no governance, Play, network, MQTT, OPC UA or MySQL side effects', () => {
  const source = [
    fs.readFileSync(path.join(root, 'lib', 'evolution', 'aasResolver.mjs'), 'utf8'),
    fs.readFileSync(path.join(root, 'lib', 'evolution', 'staticAasFileSource.mjs'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /governanceStore|governance-store|createGovernanceProfile|play-gate|playEnabled|fetch\s*\(|https?:|mqtt|opcua|mysql|cognitive|HCM|ppu/i);
});
