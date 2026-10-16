import { deterministicHash } from './functionalNormalizer.mjs';

export const FUNCTIONAL_COMPARISON_VERSION = 'aas-functional-comparator/1.0.0';

const valid = (snapshot) => snapshot && snapshot.completeness !== 'INCOMPLETE' && Array.isArray(snapshot.declarations);
const reference = (snapshot) => snapshot ? {
  aasId: snapshot.source?.aasId || null,
  administration: snapshot.source?.administration || null,
  functionalHash: snapshot.functionalHash || null,
  extractionVersion: snapshot.extractionVersion || null,
  normalizationVersion: snapshot.normalizationVersion || null,
} : null;

function identityFreeContract(item) {
  return {
    kind: item.kind,
    ...(item.identityBasis === 'SEMANTIC_REFERENCE' ? { name: item.name } : {}),
    enabled: item.enabled,
    semanticReferences: item.semanticReferences, qualifiers: item.qualifiers,
    attributes: item.attributes, evidence: item.evidence,
  };
}

function difference(type, before, current) {
  return {
    type,
    identity: current?.identity || before?.identity,
    before: before || null,
    current: current || null,
  };
}

export function compareFunctionalSnapshots(previous, current) {
  const base = {
    comparisonVersion: FUNCTIONAL_COMPARISON_VERSION,
    previous: reference(previous),
    current: reference(current),
    differences: [],
    ambiguities: [],
  };
  if (!previous) {
    return valid(current)
      ? { ...base, status: 'BASELINE' }
      : { ...base, status: 'INDETERMINATE', reason: 'CURRENT_SNAPSHOT_INCOMPLETE' };
  }
  if (!valid(previous) || !valid(current)) {
    return { ...base, status: 'INDETERMINATE', reason: !valid(previous) ? 'PREVIOUS_SNAPSHOT_INCOMPLETE' : 'CURRENT_SNAPSHOT_INCOMPLETE' };
  }
  if (previous.functionalHash === current.functionalHash) return { ...base, status: 'NO_CHANGE' };

  const beforeById = new Map(previous.declarations.map((item) => [item.identity, item]));
  const currentById = new Map(current.declarations.map((item) => [item.identity, item]));
  const removed = previous.declarations.filter((item) => !currentById.has(item.identity));
  const added = current.declarations.filter((item) => !beforeById.has(item.identity));
  const changed = current.declarations
    .filter((item) => beforeById.has(item.identity) && beforeById.get(item.identity).contractHash !== item.contractHash)
    .map((item) => difference('CHANGED', beforeById.get(item.identity), item));

  const ambiguousAdded = new Set();
  const ambiguousRemoved = new Set();
  for (const oldItem of removed) {
    for (const newItem of added) {
      if (oldItem.kind !== newItem.kind) continue;
      if (deterministicHash(identityFreeContract(oldItem)) === deterministicHash(identityFreeContract(newItem))) {
        ambiguousRemoved.add(oldItem.identity);
        ambiguousAdded.add(newItem.identity);
        base.ambiguities.push({
          code: 'AMBIGUOUS_IDENTITY_OR_RELOCATION',
          message: 'Equivalent declaration moved or renamed without a stable semantic identity.',
          beforeIdentity: oldItem.identity,
          currentIdentity: newItem.identity,
        });
      }
    }
  }
  base.differences.push(...changed);
  base.differences.push(...removed.filter((item) => !ambiguousRemoved.has(item.identity)).map((item) => difference('REMOVED', item, null)));
  base.differences.push(...added.filter((item) => !ambiguousAdded.has(item.identity)).map((item) => difference('ADDED', null, item)));
  base.differences.sort((a, b) => `${a.type}:${a.identity}`.localeCompare(`${b.type}:${b.identity}`));
  base.ambiguities.sort((a, b) => a.beforeIdentity.localeCompare(b.beforeIdentity));

  if (base.ambiguities.length) return { ...base, status: 'INDETERMINATE', reason: 'AMBIGUOUS_FUNCTIONAL_IDENTITY' };
  if (!base.differences.length) return { ...base, status: 'NO_CHANGE' };
  return { ...base, status: 'CHANGED' };
}
