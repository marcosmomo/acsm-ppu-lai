const clone = (value) => structuredClone(value);
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const equal = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));

function activeProfiles(document = {}) {
  return Object.entries(document.profiles || {}).map(([cpsId, profile]) => ({ cpsId, profile })).filter(({ profile }) =>
    ['ACTIVE', 'RESERVED', 'FAILED'].includes(String(profile?.plugCycleStatus || '').toUpperCase()));
}

function difference(category, severity, message, details = {}) { return { category, severity, message, details }; }

export function compareGovernanceShadows({ legacyDocument, candidateDocument, legacyPlayGates = {}, candidatePlayGates = {} } = {}) {
  const legacy = clone(legacyDocument || {});
  const candidate = clone(candidateDocument || {});
  const differences = [];
  const legacyActive = activeProfiles(legacy);
  const candidateActive = activeProfiles(candidate);

  for (const { cpsId, profile } of legacyActive) {
    const other = candidate.profiles?.[cpsId];
    if (!other) {
      differences.push(difference('activeProfiles', 'INCOMPATIBLE', 'Candidate is missing an active legacy profile.', { cpsId }));
      continue;
    }
    for (const field of ['profileId', 'profileVersion', 'plugEventId', 'plugCycleId', 'plugCycleStatus', 'status']) {
      if (profile?.[field] !== other?.[field]) differences.push(difference('activeProfiles', 'INCOMPATIBLE', 'Active profile identity or state differs.', { cpsId, field }));
    }
    if (!equal(profile?.policies || {}, other?.policies || {})) differences.push(difference('policies', 'INCOMPATIBLE', 'Active profile policies differ.', { cpsId }));
  }
  if (legacyActive.length !== candidateActive.length) differences.push(difference('activeProfiles', 'INCOMPATIBLE', 'Active profile counts differ.', { legacy: legacyActive.length, candidate: candidateActive.length }));

  for (const category of ['profileVersions', 'history', 'pendingActions', 'ppuOutbox']) {
    if (!equal(legacy[category] || (category === 'history' ? [] : {}), candidate[category] || (category === 'history' ? [] : {}))) {
      differences.push(difference(category, 'INCOMPATIBLE', `${category} differs from the legacy representation.`));
    }
  }

  const legacyCycles = legacy.plugCycles || {};
  const candidateCycles = candidate.plugCycles || {};
  if (!Object.keys(legacyCycles).length && Object.keys(candidateCycles).length) {
    const invalid = Object.values(candidateCycles).filter((cycle) => {
      const profile = candidate.profiles?.[cycle.cpsId];
      return !profile || profile.profileId !== cycle.governanceProfileId || profile.plugCycleId !== cycle.plugCycleId || profile.plugEventId !== cycle.plugEventId;
    });
    differences.push(invalid.length
      ? difference('plugCycles', 'INCOMPATIBLE', 'Candidate cycles are not correlated with candidate profiles.', { count: invalid.length })
      : difference('plugCycles', 'EXPECTED', 'Candidate adds explicit correlated plugCycles absent from the legacy schema.'));
  } else if (!equal(legacyCycles, candidateCycles)) {
    differences.push(difference('plugCycles', 'INCOMPATIBLE', 'Cycle representations differ.'));
  }

  const cpsIds = new Set([...Object.keys(legacyPlayGates), ...Object.keys(candidatePlayGates)]);
  for (const cpsId of cpsIds) {
    const left = legacyPlayGates[cpsId];
    const right = candidatePlayGates[cpsId];
    if (!left || !right || left.ok !== right.ok || left.governanceStatus !== right.governanceStatus) {
      differences.push(difference('playGate', 'INCOMPATIBLE', 'Play-gate decision differs.', { cpsId }));
    }
  }

  const incompatibilities = differences.filter((item) => item.severity === 'INCOMPATIBLE');
  return Object.freeze({
    compatible: incompatibilities.length === 0,
    summary: { expected: differences.length - incompatibilities.length, incompatible: incompatibilities.length },
    differences: clone(differences),
  });
}
