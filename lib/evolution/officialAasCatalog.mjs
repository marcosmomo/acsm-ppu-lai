import {
  createConfinedAasFileReader,
  createVerifiableAasDocumentSource,
} from './verifiableAasDocumentSource.mjs';

const officialReference = (entry) => Object.freeze({
  ...entry,
  sourceId: 'acsm-cps-defs-official-aas',
  sourceType: 'AUTHORIZED_OFFICIAL_AAS_DOCUMENT',
  operational: true,
});

// Locators are server-side catalog data. They are never accepted from a request.
export const CPSLAI1_OFFICIAL_AAS_REFERENCE = officialReference({
  referenceId: 'cpslai1-official-revised-aas',
  locator: 'cps-lai-01-aas-acsm-compatible-revised.json',
  cpsId: 'cpslai1',
  aasId: 'urn:ufsc:lai:ppu:cps-lai-01:aas',
  assetId: 'urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor',
  contentHash: 'b5ca586f90662dbebf5d829d92c2e53d342301b1378fb4ed0223641091ade692',
  version: '1',
  revision: '1',
});

export const CPSLAI2_OFFICIAL_AAS_REFERENCE = officialReference({
  referenceId: 'cpslai2-official-revised-aas',
  locator: 'cps-lai-02-aas-acsm-compatible-revised.json',
  cpsId: 'cpslai2',
  aasId: 'urn:ufsc:lai:ppu:cps-lai-02:aas',
  assetId: 'urn:ufsc:lai:asset:cps-lai-02:joining-station',
  contentHash: '215f4d54a253190d4fc5abb1a8a2a1a1b244a23388c8b843b827335901a2079e',
});

export const CPSLAI3_OFFICIAL_AAS_REFERENCE = officialReference({
  referenceId: 'cpslai3-official-revised-aas',
  locator: 'cps-lai-03-aas-acsm-compatible-revised.json',
  cpsId: 'cpslai3',
  aasId: 'urn:ufsc:lai:ppu:cps-lai-03:aas',
  assetId: 'urn:ufsc:lai:asset:cps-lai-03:sorting',
  contentHash: '0c388cd392ee0d385ae01ab38f6f94c7b7d2cd5224eb05a3c9b8fe372e097d9e',
});

export const OFFICIAL_AAS_CATALOG = Object.freeze(Object.fromEntries(
  [CPSLAI1_OFFICIAL_AAS_REFERENCE, CPSLAI2_OFFICIAL_AAS_REFERENCE, CPSLAI3_OFFICIAL_AAS_REFERENCE]
    .map((entry) => [entry.referenceId, entry]),
));

/** Build the INT-EVO-5 resolver over the fixed official catalog. */
export function createOfficialAasDocumentSource({ rootDir, fileSystem, archive = null } = {}) {
  const source = createConfinedAasFileReader({ rootDir, ...(fileSystem ? { fileSystem } : {}) });
  return createVerifiableAasDocumentSource({
    catalog: OFFICIAL_AAS_CATALOG,
    source,
    archive,
    sourceId: 'acsm-cps-defs-official-aas',
  });
}
