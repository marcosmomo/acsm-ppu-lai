import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compareFunctionalSnapshots } from './functionalComparator.mjs';
import { createVerifiableAasDocumentSource } from './verifiableAasDocumentSource.mjs';

export const EXPERIMENTAL_EDITABLE_AAS_REFERENCE = Object.freeze({
  referenceId: 'cpslai1-experimental-editable-aas',
  cpsId: 'cpslai1',
  aasId: 'urn:ufsc:lai:ppu:cps-lai-01:aas',
  assetId: 'urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor',
  sourceId: 'cpslai1-experimental-editable-document',
  sourceType: 'EXPERIMENTAL_EDITABLE_AAS_DOCUMENT',
  operational: false,
});

export const EXPERIMENTAL_EDITABLE_AAS_PATH = path.join(
  process.cwd(), 'cps-defs', 'evolution-experiments', 'cpslai1', 'editable-aas.json',
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const capabilityCount = (snapshot) => Array.isArray(snapshot?.declarations)
  ? snapshot.declarations.filter(({ kind }) => kind === 'CAPABILITY').length
  : null;

const maskSessionId = (id) => `${id.slice(0, 4)}…${id.slice(-4)}`;

export function buildExperimentalRefreshDiagnostics({ id, instanceId, previousEntry = null, result }) {
  return {
    sessionId: maskSessionId(id),
    sessionReset: !previousEntry,
    previousDocumentHash: previousEntry?.documentHash || null,
    currentDocumentHash: result.projection.contentHash,
    previousFunctionalHash: previousEntry?.snapshot?.functionalHash || null,
    currentFunctionalHash: result.snapshot.functionalHash,
    previousCapabilityCount: capabilityCount(previousEntry?.snapshot),
    currentCapabilityCount: capabilityCount(result.snapshot),
    evolutionStatus: result.evolution.status,
    differenceTypes: result.evolution.differences.map(({ type }) => type),
    currentProjectionHash: result.projection.contentHash,
    serverInstanceId: instanceId,
  };
}

/** Re-reads one fixed experimental document without persisting any state. */
export async function readExperimentalEditableAas({
  filePath = EXPERIMENTAL_EDITABLE_AAS_PATH,
  previousSnapshot = null,
  fileSystem = fs,
} = {}) {
  const bytes = fileSystem.readFileSync(filePath);
  const contentHash = sha256(bytes);
  const catalogEntry = {
    ...EXPERIMENTAL_EDITABLE_AAS_REFERENCE,
    locator: path.basename(filePath),
    contentHash,
  };
  const source = createVerifiableAasDocumentSource({
    catalog: { [catalogEntry.referenceId]: catalogEntry },
    source: { read: () => Buffer.from(bytes) },
    sourceId: catalogEntry.sourceId,
  });
  const projection = await source.resolve({ referenceId: catalogEntry.referenceId }, { archive: false });
  if (projection.completeness === 'INCOMPLETE') {
    throw inputError('EXPERIMENTAL_AAS_DECLARATION_INCOMPLETE', 'Experimental AAS functional declarations are incomplete.');
  }
  const evolution = compareFunctionalSnapshots(previousSnapshot, projection.functionalSnapshot);
  if (evolution.status === 'INDETERMINATE') {
    throw inputError('EXPERIMENTAL_AAS_COMPARISON_INDETERMINATE', 'Experimental AAS cannot establish a reliable functional comparison.');
  }
  return {
    schemaVersion: 'experimental-editable-aas-refresh/1.0.0',
    boundary: 'EXPERIMENTAL AAS DOCUMENT — NOT OPERATIONAL PPU STATE',
    projection: { ...projection, verifiedContentHash: projection.contentHash, archiveReference: null },
    snapshot: projection.functionalSnapshot,
    evolution,
  };
}
