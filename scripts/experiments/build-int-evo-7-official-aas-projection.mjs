import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConfinedAasFileReader, createVerifiableAasDocumentSource } from '../../lib/evolution/verifiableAasDocumentSource.mjs';
import { CPSLAI1_OFFICIAL_AAS_REFERENCE } from '../../lib/evolution/officialAasCatalog.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = createVerifiableAasDocumentSource({
  catalog: { [CPSLAI1_OFFICIAL_AAS_REFERENCE.referenceId]: CPSLAI1_OFFICIAL_AAS_REFERENCE },
  source: createConfinedAasFileReader({ rootDir: path.join(projectRoot, 'cps-defs') }),
});
const result = await source.resolve({ referenceId: CPSLAI1_OFFICIAL_AAS_REFERENCE.referenceId, cpsId: 'cpslai1' });
if (result.sourceType !== 'OFFICIAL_STATIC_DOCUMENT' || result.operational !== false) {
  throw new Error('Official document projection must remain a non-cycle-bound static preview.');
}
const sanitizedDocument = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'functionalSnapshot'));
const artifact = {
  schemaVersion: 'aas-functional-card-document/1.0',
  generatedBy: 'scripts/experiments/build-int-evo-7-official-aas-projection.mjs',
  scope: 'VERIFIED_DOCUMENT_PREVIEW_ONLY',
  cycleBinding: 'NONE',
  verification: { catalogContentHash: CPSLAI1_OFFICIAL_AAS_REFERENCE.contentHash },
  physicalValidationClaimed: false,
  operationalCycleClaimed: false,
  document: sanitizedDocument,
};
const outputPath = path.join(projectRoot, 'docs', 'experiments', 'int-evo-7-cpslai1-official-aas-projection.json');
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, contentHash: result.contentHash, capabilities: result.capabilities.length, services: result.services.length }, null, 2)}\n`);
