import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CPSLAI1_OFFICIAL_AAS_REFERENCE,
  CPSLAI2_OFFICIAL_AAS_REFERENCE,
  CPSLAI3_OFFICIAL_AAS_REFERENCE,
  OFFICIAL_AAS_CATALOG,
  createOfficialAasDocumentSource,
} from '../lib/evolution/officialAasCatalog.mjs';
import { createVerifiableAasDocumentSource, createConfinedAasFileReader } from '../lib/evolution/verifiableAasDocumentSource.mjs';

const rootDir = path.resolve('cps-defs');
const source = () => createOfficialAasDocumentSource({ rootDir });

test('official CPS-LAI-01/02/03 references resolve through the verified source', async () => {
  const expected = [
    [CPSLAI1_OFFICIAL_AAS_REFERENCE, 5, 13],
    [CPSLAI2_OFFICIAL_AAS_REFERENCE, 1, 3],
    [CPSLAI3_OFFICIAL_AAS_REFERENCE, 6, 13],
  ];
  for (const [entry, capabilities, services] of expected) {
    const result = await source().resolve({ referenceId: entry.referenceId });
    assert.equal(result.cpsId, entry.cpsId);
    assert.equal(result.aasId, entry.aasId);
    assert.equal(result.assetId, entry.assetId);
    assert.equal(result.contentHash, entry.contentHash);
    assert.equal(result.version, entry.version || null);
    assert.equal(result.administration.revision, entry.revision || null);
    assert.equal(result.capabilities.length, capabilities);
    assert.equal(result.services.length, services);
    assert.equal(result.completeness, 'COMPLETE_WITH_WARNINGS');
    assert.equal(result.sourceType, 'AUTHORIZED_OFFICIAL_AAS_DOCUMENT');
    assert.equal(result.sourceId, 'acsm-cps-defs-official-aas');
    assert.equal(result.operational, true);
    assert.equal(result.evidenceLevel, 'DECLARED_ONLY');
    assert.equal(result.physicalStateInferred, false);
  }
});

test('catalog references and entries are immutable and only explicit official ids are authorized', async () => {
  assert.equal(Object.isFrozen(OFFICIAL_AAS_CATALOG), true);
  assert.equal(Object.isFrozen(CPSLAI1_OFFICIAL_AAS_REFERENCE), true);
  await assert.rejects(source().resolve({ referenceId: 'avm-v1' }), { code: 'AAS_REFERENCE_NOT_AUTHORIZED' });
  await assert.rejects(source().resolve({ referenceId: '../../cps-lai-01-aas-acsm-compatible-revised.json' }), {
    code: 'AAS_REFERENCE_NOT_AUTHORIZED',
  });
});

test('requested hash mismatch and path escape are rejected', async () => {
  await assert.rejects(source().resolve({
    referenceId: CPSLAI2_OFFICIAL_AAS_REFERENCE.referenceId,
    contentHash: '0'.repeat(64),
  }), { code: 'AAS_EXPECTED_HASH_MISMATCH' });
  assert.throws(() => createConfinedAasFileReader({ rootDir }).read({ locator: '../package.json' }), {
    code: 'AAS_SOURCE_PATH_ESCAPE',
  });
});

test('document bytes with a changed digest or divergent identity are rejected', async () => {
  const entry = CPSLAI1_OFFICIAL_AAS_REFERENCE;
  const bytes = fs.readFileSync(path.join(rootDir, entry.locator));
  const changed = Buffer.from(bytes.toString('utf8').replace(entry.aasId, 'urn:wrong:aas'));
  const hash = createHash('sha256').update(changed).digest('hex');
  const catalogEntry = {
    ...entry,
    contentHash: hash,
  };
  const injected = createVerifiableAasDocumentSource({
    catalog: { [entry.referenceId]: catalogEntry },
    source: { read: () => changed },
  });
  await assert.rejects(injected.resolve({ referenceId: entry.referenceId }), { code: 'AAS_IDENTITY_MISMATCH' });

  const mismatchedBytesSource = createVerifiableAasDocumentSource({
    catalog: { [entry.referenceId]: entry },
    source: { read: () => changed },
  });
  await assert.rejects(mismatchedBytesSource.resolve({ referenceId: entry.referenceId }), { code: 'AAS_CONTENT_HASH_MISMATCH' });
});

test('invalid documents and catalog identity mismatches fail closed', async () => {
  const entry = CPSLAI3_OFFICIAL_AAS_REFERENCE;
  const invalid = Buffer.from('{not json');
  const invalidSource = createVerifiableAasDocumentSource({
    catalog: { [entry.referenceId]: { ...entry, contentHash: createHash('sha256').update(invalid).digest('hex') } },
    source: { read: () => invalid },
  });
  await assert.rejects(invalidSource.resolve({ referenceId: entry.referenceId }), { code: 'AAS_DOCUMENT_INVALID' });

  await assert.rejects(source().resolve({ referenceId: entry.referenceId, cpsId: 'cpslai2' }), {
    code: 'AAS_IDENTITY_MISMATCH',
  });
});

test('catalog and source stay isolated from PPU operations and experimental catalogs', () => {
  const implementation = fs.readFileSync(path.resolve('lib/evolution/officialAasCatalog.mjs'), 'utf8');
  assert.doesNotMatch(implementation, /PlugFase|CPSContext|governanceStore|EvolutionStore|fetch\(|experimentalAasCatalog/);
  assert.match(implementation, /createVerifiableAasDocumentSource/);
  assert.equal(Object.keys(OFFICIAL_AAS_CATALOG).length, 3);
});
