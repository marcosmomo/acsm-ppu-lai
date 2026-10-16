import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from '../lib/evolution/experimentalAasCatalog.mjs';
import {
  createConfinedAasFileReader,
  createVerifiableAasDocumentSource,
} from '../lib/evolution/verifiableAasDocumentSource.mjs';

const rootDir = path.resolve('cps-defs');
const versions = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions;
const catalog = Object.fromEntries(Object.entries(versions).map(([version, item]) => [`avm-${version}`, {
  locator: item.relativePath,
  cpsId: 'cpslai1',
  aasId: item.aasId,
  assetId: item.assetId,
  contentHash: item.sha256,
  version,
  sourceId: 'avm-1b-fixtures',
  sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT',
  operational: false,
}]));

const makeSource = (overrides = {}) => createVerifiableAasDocumentSource({
  catalog: overrides.catalog || catalog,
  source: overrides.source || createConfinedAasFileReader({ rootDir }),
  archive: overrides.archive || null,
});

test('V1 V2 V3 are resolved from authorized bytes and remain explicitly experimental', async () => {
  for (const [version, capabilityCount] of [['v1', 6], ['v2', 6], ['v3', 7]]) {
    const result = await makeSource().resolve({ referenceId: `avm-${version}`, cpsId: 'CPS-LAI-01' });
    assert.equal(result.cpsId, 'cpslai1');
    assert.equal(result.version, version);
    assert.equal(result.administration.version, '1');
    assert.equal(result.contentHash, versions[version].sha256);
    assert.equal(result.capabilities.length, capabilityCount);
    assert.equal(result.sourceType, 'EXPERIMENTAL_STATIC_DOCUMENT');
    assert.equal(result.operational, false);
    assert.equal(result.evidenceLevel, 'DECLARED_ONLY');
    assert.equal(result.physicalStateInferred, false);
  }
});

test('operational classification is possible only when explicitly authorized by its catalog', async () => {
  const operationalCatalog = {
    official: {
      locator: 'cps-lai-01-aas-acsm-compatible-revised.json',
      cpsId: 'cpslai1',
      aasId: 'urn:ufsc:lai:ppu:cps-lai-01:aas',
      assetId: 'urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor',
      contentHash: 'b5ca586f90662dbebf5d829d92c2e53d342301b1378fb4ed0223641091ade692',
      version: '1',
      sourceId: 'future-authoritative-registry',
      sourceType: 'OPERATIONAL_AAS_DOCUMENT',
      operational: true,
    },
  };
  const result = await makeSource({ catalog: operationalCatalog }).resolve({ referenceId: 'official' });
  assert.equal(result.sourceType, 'OPERATIONAL_AAS_DOCUMENT');
  assert.equal(result.sourceId, 'future-authoritative-registry');
  assert.equal(result.operational, true);
});

test('PieceAtMiddle changes in V2 and adaptive capability exists only in V3', async () => {
  const [v1, v2, v3] = await Promise.all(['v1', 'v2', 'v3'].map((version) =>
    makeSource().resolve({ referenceId: `avm-${version}` })));
  const piece = (projection) => projection.capabilities.find((item) => item.name === 'PieceDetection');
  assert.equal(piece(v1).attributes.PieceAtMiddle.value, 'true');
  assert.equal(piece(v2).attributes.PieceAtMiddle.value, 'false');
  assert.equal(piece(v3).attributes.PieceAtMiddle.value, 'false');
  assert.equal(v1.capabilities.some((item) => item.name === 'ExperimentalAdaptivePieceDetection'), false);
  assert.equal(v2.capabilities.some((item) => item.name === 'ExperimentalAdaptivePieceDetection'), false);
  assert.equal(v3.capabilities.some((item) => item.name === 'ExperimentalAdaptivePieceDetection'), true);
});

test('invalid JSON, divergent identity and divergent hashes are rejected', async () => {
  const bytes = fs.readFileSync(path.join(rootDir, versions.v1.relativePath));
  const invalidBytes = Buffer.from('{invalid');
  const invalidHash = createHash('sha256').update(invalidBytes).digest('hex');
  const invalid = makeSource({
    catalog: { invalid: { ...catalog['avm-v1'], contentHash: invalidHash } },
    source: { read: async () => invalidBytes },
  });
  await assert.rejects(invalid.resolve({ referenceId: 'invalid' }), { code: 'AAS_DOCUMENT_INVALID' });

  const alteredDocument = JSON.parse(bytes.toString('utf8'));
  alteredDocument.assetAdministrationShells[0].id = 'urn:divergent';
  const alteredBytes = Buffer.from(JSON.stringify(alteredDocument));
  const alteredHash = createHash('sha256').update(alteredBytes).digest('hex');
  const divergent = makeSource({
    catalog: { only: { ...catalog['avm-v1'], contentHash: alteredHash } },
    source: { read: async () => alteredBytes },
  });
  await assert.rejects(divergent.resolve({ referenceId: 'only' }), { code: 'AAS_IDENTITY_MISMATCH' });

  await assert.rejects(makeSource().resolve({ referenceId: 'avm-v1', contentHash: '0'.repeat(64) }), {
    code: 'AAS_EXPECTED_HASH_MISMATCH',
  });
});

test('arbitrary references and paths are never accepted from the request', async () => {
  await assert.rejects(makeSource().resolve({ referenceId: '../../cps-lai-01-aas-acsm-compatible-revised.json' }), {
    code: 'AAS_REFERENCE_NOT_AUTHORIZED',
  });
  assert.throws(() => createConfinedAasFileReader({ rootDir }).read({ locator: '../package.json' }), {
    code: 'AAS_SOURCE_PATH_ESCAPE',
  });
});

test('archive receives server-read bytes and verified hash for future freezing', async () => {
  let archived = null;
  const archive = { archive: async (input) => {
    archived = input;
    return { reference: `sha256:${input.expectedHash}`, contentHash: input.expectedHash };
  } };
  const result = await makeSource({ archive }).resolve({ referenceId: 'avm-v1' });
  assert.ok(Buffer.isBuffer(archived.bytes));
  assert.equal(archived.expectedHash, versions.v1.sha256);
  assert.equal(result.archiveReference.contentHash, versions.v1.sha256);
});

test('module is isolated from PPU, governance, stores, network and experimental defaults', () => {
  const source = fs.readFileSync(path.resolve('lib/evolution/verifiableAasDocumentSource.mjs'), 'utf8');
  assert.doesNotMatch(source, /PlugFase|CPSContext|governanceStore|EvolutionStore|fetch\(|https?:|experimentalAasResolver/);
  assert.match(source, /buildFunctionalSnapshot/);
});
