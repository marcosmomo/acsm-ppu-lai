export const EXPERIMENTAL_AAS_CATALOG_VERSION = 'experimental-aas-catalog/1.0.0';

const AAS_ID = 'urn:ufsc:lai:ppu:cps-lai-01:aas';
const ASSET_ID = 'urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor';

export const CPSLAI1_EXPERIMENTAL_AAS_CATALOG = Object.freeze({
  schemaVersion: '1.0',
  catalogVersion: EXPERIMENTAL_AAS_CATALOG_VERSION,
  sourceClassification: 'EXPERIMENTAL_STATIC_DOCUMENT',
  cps: Object.freeze({
    cpslai1: Object.freeze({
      cpsId: 'cpslai1',
      aasId: AAS_ID,
      assetId: ASSET_ID,
      versions: Object.freeze({
        v1: Object.freeze({
          version: 'v1',
          relativePath: 'evolution-experiments/cpslai1/aas-v1.json',
          aasId: AAS_ID,
          assetId: ASSET_ID,
          sha256: '7cd277a57c690f936024ca6ca4c4487be7e35ae1d0617b410cba902b46870cfb',
          description: 'AVM-1B experimental enriched baseline with declared PieceDetection support.',
          sourceClassification: 'EXPERIMENTAL_STATIC_DOCUMENT',
        }),
        v2: Object.freeze({
          version: 'v2',
          relativePath: 'evolution-experiments/cpslai1/aas-v2.json',
          aasId: AAS_ID,
          assetId: ASSET_ID,
          sha256: 'b406945e7c540c2013390ff3f111116cb90093d106e2df629f2daf6f018f32fd',
          description: 'AVM-1B experimental version with PieceDetection/PieceAtMiddle disabled.',
          sourceClassification: 'EXPERIMENTAL_STATIC_DOCUMENT',
        }),
        v3: Object.freeze({
          version: 'v3',
          relativePath: 'evolution-experiments/cpslai1/aas-v3.json',
          aasId: AAS_ID,
          assetId: ASSET_ID,
          sha256: 'f79fbe4b819d3bc1d477f540ce1a3f024ad9f739cf7e72e91fe210913b28c33d',
          description: 'AVM-1B experimental version adding a synthetic, non-physically-validated capability.',
          sourceClassification: 'EXPERIMENTAL_STATIC_DOCUMENT',
        }),
      }),
    }),
  }),
});

export function listExperimentalAasVersions(catalog = CPSLAI1_EXPERIMENTAL_AAS_CATALOG) {
  return Object.values(catalog.cps.cpslai1.versions).map((entry) => ({ ...entry }));
}
