import { createHash } from 'node:crypto';
import { extractFunctionalDeclarations, FUNCTIONAL_EXTRACTION_VERSION } from './functionalExtractor.mjs';

export const FUNCTIONAL_NORMALIZATION_VERSION = 'aas-functional-normalizer/1.0.0';

const normalizeText = (value) => typeof value === 'string' ? value.trim() : value;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return normalizeText(value);
}
export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function deterministicHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function semanticIdentity(references) {
  return references.length ? `semantic:${references.map((item) => `${item.type || 'GlobalReference'}:${item.value}`).join('|')}` : null;
}

function normalizeDeclaration(item) {
  const semanticReferences = canonicalize(item.semanticReferences || []);
  const technicalIdentity = [item.kind, item.source.submodelId || item.source.submodelIdShort, item.source.path]
    .map((value) => String(value || '').trim().toLowerCase()).join(':');
  const identity = semanticIdentity(semanticReferences) || `technical:${technicalIdentity}`;
  const contract = canonicalize({
    kind: item.kind,
    name: item.name,
    enabled: item.enabled,
    semanticReferences,
    qualifiers: item.qualifiers || [],
    attributes: item.attributes || {},
    evidence: item.evidence,
  });
  return {
    identity,
    identityBasis: semanticReferences.length ? 'SEMANTIC_REFERENCE' : 'TECHNICAL_PATH',
    technicalIdentity,
    ...contract,
    source: canonicalize(item.source),
    contractHash: deterministicHash(contract),
  };
}

export function normalizeFunctionalSnapshot(extraction) {
  const normalized = (extraction?.declarations || []).map(normalizeDeclaration)
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const duplicateIdentities = [...new Set(normalized
    .filter((item, index) => normalized.findIndex((candidate) => candidate.identity === item.identity) !== index)
    .map((item) => item.identity))];
  const issues = [...(extraction?.issues || [])];
  for (const identity of duplicateIdentities) {
    issues.push({ severity: 'ERROR', code: 'AMBIGUOUS_DUPLICATE_IDENTITY', identity });
  }
  const completeness = issues.some((item) => item.severity === 'ERROR') ? 'INCOMPLETE' : issues.length ? 'COMPLETE_WITH_WARNINGS' : 'COMPLETE';
  const functionalDocument = {
    extractionVersion: extraction?.extractionVersion || FUNCTIONAL_EXTRACTION_VERSION,
    normalizationVersion: FUNCTIONAL_NORMALIZATION_VERSION,
    declarations: normalized,
  };
  return {
    schemaVersion: '1.0',
    extractionVersion: functionalDocument.extractionVersion,
    normalizationVersion: FUNCTIONAL_NORMALIZATION_VERSION,
    source: canonicalize(extraction?.source || {}),
    completeness,
    issues: canonicalize(issues),
    declarations: normalized,
    functionalHash: deterministicHash(functionalDocument),
  };
}

export function buildFunctionalSnapshot(aasEnvironment) {
  return normalizeFunctionalSnapshot(extractFunctionalDeclarations(aasEnvironment));
}
