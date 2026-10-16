import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from '../../lib/evolution/experimentalAasCatalog.mjs';
import { createExperimentalAasResolver } from '../../lib/evolution/experimentalAasResolver.mjs';
import { compareFunctionalSnapshots } from '../../lib/evolution/functionalComparator.mjs';
import { buildFunctionalSnapshot } from '../../lib/evolution/functionalNormalizer.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const aasRoot = path.join(projectRoot, 'cps-defs');
const outputPath = path.join(projectRoot, 'docs', 'experiments', 'avm3-cpslai1-version-manager.json');
const resolver = createExperimentalAasResolver({ rootDir: aasRoot });

const versions = {};
const snapshots = {};
for (const version of ['v1', 'v2', 'v3']) {
  const resolved = await resolver.resolve({ cpsId: 'cpslai1', aasVersion: version });
  const snapshot = buildFunctionalSnapshot(resolved.document);
  snapshots[version] = snapshot;
  versions[version] = {
    version,
    label: version === 'v1' ? 'V1 — baseline experimental'
      : version === 'v2' ? 'V2 — PieceAtMiddle desabilitada'
        : 'V3 — ExperimentalAdaptivePieceDetection adicionada',
    description: resolved.provenance.description,
    aasId: resolved.identity.aasId,
    assetId: resolved.identity.assetId,
    aasSha256: resolved.integrity.contentHash,
    functionalHash: snapshot.functionalHash,
    sourceClassification: resolved.provenance.sourceType,
    sourceLocator: resolved.provenance.locator,
    completeness: snapshot.completeness,
    capabilities: snapshot.declarations.filter((item) => item.kind === 'CAPABILITY').map((item) => ({
      identity: item.identity,
      name: item.name,
      enabled: item.enabled,
      attributes: Object.fromEntries(Object.entries(item.attributes || {}).map(([name, attribute]) => [name, attribute.value])),
      evidenceLevel: item.evidence?.level || null,
      physicallyValidated: item.evidence?.physicallyValidated === true,
    })),
  };
}

function changedAttributes(before, current) {
  const result = [];
  const left = before?.attributes || {};
  const right = current?.attributes || {};
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const beforeValue = left[name]?.value ?? null;
    const currentValue = right[name]?.value ?? null;
    if (beforeValue !== currentValue) result.push({ name, before: beforeValue, current: currentValue });
  }
  return result;
}

function comparison(id, previousVersion, currentVersion) {
  const result = previousVersion
    ? compareFunctionalSnapshots(snapshots[previousVersion], snapshots[currentVersion])
    : compareFunctionalSnapshots(null, snapshots[currentVersion]);
  return {
    id,
    previousVersion,
    currentVersion,
    status: result.status,
    previousAasSha256: previousVersion ? versions[previousVersion].aasSha256 : null,
    currentAasSha256: versions[currentVersion].aasSha256,
    previousFunctionalHash: previousVersion ? versions[previousVersion].functionalHash : null,
    currentFunctionalHash: versions[currentVersion].functionalHash,
    differences: result.differences.map((item) => ({
      type: item.type,
      identity: item.identity,
      capabilityBefore: item.before?.name || null,
      capabilityCurrent: item.current?.name || null,
      enabledBefore: item.before?.enabled ?? null,
      enabledCurrent: item.current?.enabled ?? null,
      changedAttributes: changedAttributes(item.before, item.current),
    })),
    ambiguities: result.ambiguities,
  };
}

const artifact = {
  schemaVersion: 'AVM-3-view/1.0',
  generatedBy: 'scripts/experiments/build-avm3-version-manager-artifact.mjs',
  evidenceScope: 'OFFLINE_DOCUMENTAL_AAS',
  physicalValidationClaimed: false,
  sourceCatalogVersion: CPSLAI1_EXPERIMENTAL_AAS_CATALOG.catalogVersion,
  previewBinding: {
    status: 'PREVIEW_NOT_BOUND_TO_PLUG_CYCLE',
    plugEventId: null,
    plugCycleId: null,
    profileId: null,
    selectionId: null,
  },
  versions,
  comparisons: [
    comparison('baseline-v1', null, 'v1'),
    comparison('v1-v2', 'v1', 'v2'),
    comparison('v2-v3', 'v2', 'v3'),
    comparison('v1-v3', 'v1', 'v3'),
  ],
};

fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
