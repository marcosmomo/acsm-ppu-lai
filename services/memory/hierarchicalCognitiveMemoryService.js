export const MAX_COGNITIVE_MEMORY_SIZE = 500;
export const COGNITIVE_MEMORY_SCHEMA_VERSION = '1.0';
export const COGNITIVE_MEMORY_MESSAGE_TYPE = 'cognitive_snapshot';
export const MIN_TARGET_SAMPLES = 3;

const allowedLevels = new Set(['level1', 'level2', 'level3', 'level4']);
const memoryStore = new Map();

const isBrowserStorageAvailable = () => {
  if (typeof window === 'undefined' || !window.localStorage) return false;

  try {
    const testKey = '__hcm_storage_test__';
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
};

const toPlainObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const toArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

const safeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const toNumber = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeLevel = (level) => {
  const normalized = safeText(level).toLowerCase();
  if (allowedLevels.has(normalized)) return normalized;
  throw new Error(`Invalid cognitive memory level: ${String(level)}`);
};

const normalizeSource = (source) => {
  const normalized = safeText(source);
  if (!normalized) {
    throw new Error('Cognitive memory source is required.');
  }
  return normalized;
};

const normalizeKeyPart = (value) =>
  safeText(value, 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';

export const getCognitiveMemoryStorageKey = (level, source) =>
  `hcm_${normalizeKeyPart(normalizeLevel(level))}_${normalizeKeyPart(normalizeSource(source))}`;

const clone = (value) => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

const normalizeMetadata = (metadata = {}) => {
  const source = toPlainObject(metadata);

  return {
    originTopic: safeText(source.originTopic),
    relatedTopics: toArray(source.relatedTopics),
    inputMessageTypes: toArray(source.inputMessageTypes),
    window: toPlainObject(source.window),
    traceId: safeText(source.traceId),
    parentTraceId: safeText(source.parentTraceId),
    confidence: source.confidence ?? null,
    riskLevel: source.riskLevel ?? null,
    ...source,
  };
};

const firstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

const pickNestedNumber = (snapshot, paths) => {
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), snapshot);
    const numeric = toNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
};

const extractOee = (snapshot) =>
  pickNestedNumber(snapshot, [
    'observed.oee',
    'observed.oee.oee',
    'observed.oee.value',
    'observed.globalOEE',
    'observed.globalOEE.oee',
    'observed.globalOEE.current',
    'knowledge.oee',
    'knowledge.oee.oee',
    'knowledge.globalOEE',
    'knowledge.globalOEE.oee',
    'knowledge.globalOEE.current',
    'prediction.expectedOEE',
    'prediction.expectedOee',
    'prediction.forecastOEE',
    'metadata.oee',
  ]);

const extractAvailability = (snapshot) =>
  pickNestedNumber(snapshot, [
    'observed.availability',
    'observed.oee.availability',
    'observed.globalOEE.availability',
    'knowledge.availability',
    'knowledge.oee.availability',
    'knowledge.globalOEE.availability',
    'metadata.availability',
  ]);

const extractPerformance = (snapshot) =>
  pickNestedNumber(snapshot, [
    'observed.performance',
    'observed.oee.performance',
    'observed.globalOEE.performance',
    'knowledge.performance',
    'knowledge.oee.performance',
    'knowledge.globalOEE.performance',
    'metadata.performance',
  ]);

const extractQuality = (snapshot) =>
  pickNestedNumber(snapshot, [
    'observed.quality',
    'observed.oee.quality',
    'observed.globalOEE.quality',
    'knowledge.quality',
    'knowledge.oee.quality',
    'knowledge.globalOEE.quality',
    'metadata.quality',
  ]);

const extractRiskLevel = (snapshot) =>
  safeText(
    firstPresent(
      snapshot?.metadata?.riskLevel,
      snapshot?.observed?.riskLevel,
      snapshot?.knowledge?.riskLevel,
      snapshot?.learning?.riskLevel,
      snapshot?.reasoning?.riskLevel,
      snapshot?.prediction?.riskLevel,
      snapshot?.prediction?.risk,
      snapshot?.decision?.riskLevel
    )
  );

const extractConfidence = (snapshot) =>
  toNumber(
    firstPresent(
      snapshot?.metadata?.confidence,
      snapshot?.observed?.confidence,
      snapshot?.knowledge?.confidence,
      snapshot?.learning?.confidence,
      snapshot?.reasoning?.confidence,
      snapshot?.prediction?.confidence,
      snapshot?.decision?.confidence
    )
  );

const extractLearningPattern = (snapshot) =>
  safeText(
    firstPresent(
      snapshot?.learning?.pattern,
      snapshot?.learning?.learningPattern,
      snapshot?.knowledge?.learningPattern,
      snapshot?.knowledge?.learnedPattern,
      snapshot?.reasoning?.dominantLoss
    )
  );

const extractRecommendation = (snapshot) =>
  safeText(
    firstPresent(
      snapshot?.decision?.recommendation,
      snapshot?.reasoning?.recommendation,
      snapshot?.knowledge?.recommendation,
      snapshot?.feedback?.recommendation,
      snapshot?.decision?.coordinationMessage
    )
  );

const countMostFrequent = (values) => {
  const counts = values.filter(Boolean).reduce((acc, value) => {
    acc.set(value, (acc.get(value) || 0) + 1);
    return acc;
  }, new Map());

  let winner = '';
  let winnerCount = 0;
  counts.forEach((count, value) => {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  });

  return winner;
};

const mean = (values) => {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
};

const round = (value, digits = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const maxOrNull = (values) => {
  const numbers = values.filter((value) => Number.isFinite(value));
  return numbers.length ? Math.max(...numbers) : null;
};

const minOrNull = (values) => {
  const numbers = values.filter((value) => Number.isFinite(value));
  return numbers.length ? Math.min(...numbers) : null;
};

export const createCognitiveSnapshot = ({
  level,
  source,
  target = '',
  observed = {},
  knowledge = {},
  learning = {},
  reasoning = {},
  prediction = {},
  decision = {},
  feedback = {},
  effectiveness = {},
  metadata = {},
} = {}) => {
  const normalizedLevel = normalizeLevel(level);
  const normalizedSource = normalizeSource(source);
  const timestamp = new Date().toISOString();

  return {
    schemaVersion: COGNITIVE_MEMORY_SCHEMA_VERSION,
    messageType: COGNITIVE_MEMORY_MESSAGE_TYPE,
    level: normalizedLevel,
    source: normalizedSource,
    target: safeText(target),
    ts: Date.now(),
    timestamp,
    observed: clone(toPlainObject(observed)),
    knowledge: clone(toPlainObject(knowledge)),
    learning: clone(toPlainObject(learning)),
    reasoning: clone(toPlainObject(reasoning)),
    prediction: clone(toPlainObject(prediction)),
    decision: clone(toPlainObject(decision)),
    feedback: clone(toPlainObject(feedback)),
    effectiveness: clone(toPlainObject(effectiveness)),
    metadata: clone(normalizeMetadata(metadata)),
  };
};

const readMemory = (level, source) => {
  const key = getCognitiveMemoryStorageKey(level, source);

  if (isBrowserStorageAvailable()) {
    try {
      const stored = window.localStorage.getItem(key);
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return memoryStore.get(key) || [];
};

const writeMemory = (level, source, snapshots) => {
  const key = getCognitiveMemoryStorageKey(level, source);
  const bounded = Array.isArray(snapshots)
    ? snapshots.slice(-MAX_COGNITIVE_MEMORY_SIZE)
    : [];

  if (isBrowserStorageAvailable()) {
    try {
      window.localStorage.setItem(key, JSON.stringify(bounded));
    } catch {
      memoryStore.set(key, bounded);
    }
    return bounded;
  }

  memoryStore.set(key, bounded);
  return bounded;
};

export const appendCognitiveSnapshot = (level, source, snapshot) => {
  const normalizedLevel = normalizeLevel(level);
  const normalizedSource = normalizeSource(source);
  const normalizedSnapshot =
    snapshot?.messageType === COGNITIVE_MEMORY_MESSAGE_TYPE
      ? {
          ...createCognitiveSnapshot({
            level: normalizedLevel,
            source: normalizedSource,
            target: snapshot.target,
            observed: snapshot.observed,
            knowledge: snapshot.knowledge,
            learning: snapshot.learning,
            reasoning: snapshot.reasoning,
            prediction: snapshot.prediction,
            decision: snapshot.decision,
            feedback: snapshot.feedback,
            effectiveness: snapshot.effectiveness,
            metadata: snapshot.metadata,
          }),
          ts: Number.isFinite(Number(snapshot.ts)) ? Number(snapshot.ts) : Date.now(),
          timestamp: safeText(snapshot.timestamp, new Date().toISOString()),
        }
      : createCognitiveSnapshot({
          ...(toPlainObject(snapshot)),
          level: normalizedLevel,
          source: normalizedSource,
        });

  const currentMemory = readMemory(normalizedLevel, normalizedSource);
  return writeMemory(normalizedLevel, normalizedSource, [
    ...currentMemory,
    normalizedSnapshot,
  ]);
};

export const getCognitiveMemory = (level, source) =>
  clone(readMemory(normalizeLevel(level), normalizeSource(source)));

export const getLatestCognitiveSnapshot = (level, source) => {
  const memory = readMemory(normalizeLevel(level), normalizeSource(source));
  return clone(memory.at(-1) || null);
};

export const clearCognitiveMemory = (level, source) => {
  const key = getCognitiveMemoryStorageKey(level, source);

  if (isBrowserStorageAvailable()) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      memoryStore.delete(key);
    }
  } else {
    memoryStore.delete(key);
  }

  return [];
};

export const summarizeCognitiveMemory = (level, source) => {
  const normalizedLevel = normalizeLevel(level);
  const normalizedSource = normalizeSource(source);
  const memory = readMemory(normalizedLevel, normalizedSource);
  const latest = memory.at(-1) || null;
  const oeeValues = memory.map(extractOee).filter((value) => value !== null);

  return {
    level: normalizedLevel,
    source: normalizedSource,
    samples: memory.length,
    firstTimestamp: safeText(memory[0]?.timestamp),
    lastTimestamp: safeText(latest?.timestamp),
    latestRiskLevel: latest ? extractRiskLevel(latest) : '',
    latestConfidence: latest ? extractConfidence(latest) : null,
    latestOEE: latest ? extractOee(latest) : null,
    meanOEE: round(mean(oeeValues)),
    bestOEE: round(maxOrNull(oeeValues)),
    worstOEE: round(minOrNull(oeeValues)),
    dominantRiskLevel: countMostFrequent(memory.map(extractRiskLevel)),
    dominantLearningPattern: countMostFrequent(memory.map(extractLearningPattern)),
    mostFrequentRecommendation: countMostFrequent(memory.map(extractRecommendation)),
    recentEffectiveness: clone(toPlainObject(latest?.effectiveness)),
  };
};

export const deriveTargetsFromCognitiveMemory = (level, source) => {
  const normalizedLevel = normalizeLevel(level);
  const normalizedSource = normalizeSource(source);
  const memory = readMemory(normalizedLevel, normalizedSource);
  const oeeValues = memory.map(extractOee).filter((value) => value !== null);
  const availabilityValues = memory.map(extractAvailability).filter((value) => value !== null);
  const performanceValues = memory.map(extractPerformance).filter((value) => value !== null);
  const qualityValues = memory.map(extractQuality).filter((value) => value !== null);
  const hasEnoughSamples =
    oeeValues.length >= MIN_TARGET_SAMPLES ||
    availabilityValues.length >= MIN_TARGET_SAMPLES ||
    performanceValues.length >= MIN_TARGET_SAMPLES ||
    qualityValues.length >= MIN_TARGET_SAMPLES;

  if (!hasEnoughSamples) {
    return {
      targetOEE: 0.85,
      targetAvailability: 0.9,
      targetPerformance: 0.9,
      targetQuality: 0.95,
      basis: 'fallback_default',
      samples: memory.length,
      confidence: 0.2,
    };
  }

  const usableSamples = Math.max(
    oeeValues.length,
    availabilityValues.length,
    performanceValues.length,
    qualityValues.length
  );

  return {
    targetOEE: round(maxOrNull(oeeValues)),
    targetAvailability: round(maxOrNull(availabilityValues)),
    targetPerformance: round(maxOrNull(performanceValues)),
    targetQuality: round(maxOrNull(qualityValues)),
    basis: 'historical_best',
    samples: memory.length,
    confidence: round(Math.min(0.95, 0.25 + usableSamples / 100), 2),
  };
};

export const hierarchicalCognitiveMemoryService = {
  createCognitiveSnapshot,
  appendCognitiveSnapshot,
  getCognitiveMemory,
  getLatestCognitiveSnapshot,
  clearCognitiveMemory,
  summarizeCognitiveMemory,
  deriveTargetsFromCognitiveMemory,
  getCognitiveMemoryStorageKey,
};
