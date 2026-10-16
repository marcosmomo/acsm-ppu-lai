import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExperimentalAasResolver } from '../../lib/evolution/experimentalAasResolver.mjs';
import { extractFunctionalDeclarations } from '../../lib/evolution/functionalExtractor.mjs';
import { normalizeFunctionalSnapshot } from '../../lib/evolution/functionalNormalizer.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultOutput = path.join(workspaceRoot, 'docs', 'experiments', 'avm7-cpslai1-functional-projection.json');

function projectDeclaration(declaration) {
  return {
    kind: declaration.kind,
    name: declaration.name,
    enabled: declaration.enabled,
    identity: declaration.identity,
    identityBasis: declaration.identityBasis,
    technicalIdentity: declaration.technicalIdentity,
    semanticReferences: declaration.semanticReferences,
    attributes: Object.fromEntries(Object.entries(declaration.attributes || {}).map(([name, attribute]) => [name, {
      valueType: attribute.valueType,
      value: attribute.value,
      semanticReferences: attribute.semanticReferences || [],
    }])),
    evidenceLevel: declaration.evidence.level,
    experimental: /^Experimental/.test(declaration.name),
  };
}

export async function buildAvm7FunctionalProjection({ outputPath = defaultOutput } = {}) {
  const resolver = createExperimentalAasResolver({ rootDir: path.join(workspaceRoot, 'cps-defs') });
  const versions = [];
  for (const version of ['v1', 'v2', 'v3']) {
    const resolved = await resolver.resolve({ cpsId: 'cpslai1', aasVersion: version });
    const extraction = extractFunctionalDeclarations(resolved.document);
    const normalized = normalizeFunctionalSnapshot(extraction);
    const declarations = normalized.declarations.map(projectDeclaration);
    versions.push({
      version,
      cpsId: resolved.identity.cpsId,
      aasId: resolved.identity.aasId,
      assetId: resolved.identity.assetId,
      sha256: resolved.integrity.contentHash,
      sourceClassification: resolved.provenance.sourceType,
      completeness: normalized.completeness,
      functionalHash: normalized.functionalHash,
      capabilities: declarations.filter((item) => item.kind === 'CAPABILITY'),
      services: declarations.filter((item) => item.kind === 'SERVICE'),
    });
  }
  const artifact = {
    schemaVersion: 'AVM-7-functional-projection/1.0',
    generatedBy: 'scripts/experiments/build-avm7-functional-projection.mjs',
    scope: 'OFFLINE_DECLARATIONS_ONLY',
    physicalValidationClaimed: false,
    operationalDataIncluded: false,
    versions,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = await buildAvm7FunctionalProjection();
  process.stdout.write(`${JSON.stringify({ outputPath: defaultOutput, versions: artifact.versions.map((item) => item.version) })}\n`);
}
