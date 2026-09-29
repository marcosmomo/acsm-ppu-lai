import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_PARTIAL_GAIN_THRESHOLD = 0.01;
const VALID_EPISODE_STATUS = new Set(['open', 'closed', 'timeout']);
const VALID_EVENT_SOURCES = new Set(['acsm1', 'cps', 'hcm', 'system', 'node-red']);
const VALID_EVENT_TYPES = new Set([
  'learning',
  'reasoning',
  'prediction',
  'recommendation',
  'decision',
  'action',
  'feedback',
  'effectiveness',
  'experience_learned',
  'ppu_event',
  'state_update',
  'governance_profile_created',
  'governance_profile_approved',
  'governance_profile_rejected',
  'governance_check',
  'governance_human_decision',
  'governed_action_executed',
  'knowledge_curated',
]);
const VALID_EFFECTIVENESS = new Set(['effective', 'partially_effective', 'ineffective', 'unknown']);
const VALID_CURATION_STATUS = new Set(['CONFIRMED', 'REJECTED', 'ANNOTATED']);
const IMMUTABLE_KNOWLEDGE_FIELDS = new Set([
  'knowledgeId',
  'cpsId',
  'source',
  'createdAt',
  'originalKnowledge',
]);

const inMemoryStore = { episodes: [], events: [], decisions: [], effectiveness: [], knowledgeItems: [] };
const HCM_READ_CACHE_KEY = '__acsmHcmReadCache';

const dataFilePath = () =>
  process.env.HCM_STORE_PATH || path.join(process.cwd(), 'data', 'hcm-store.json');

const nowIso = () => new Date().toISOString();
const clone = (value) => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};
const toObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const toArray = (value) => (Array.isArray(value) ? value : []);
const safeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};
const toFiniteNumber = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const applyLimit = (items, limit) => {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric <= 0) return items;
  return items.slice(0, Math.floor(numeric));
};
const round = (value, digits = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const makeId = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const firstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

const normalizeStore = (store = {}) => ({
  episodes: toArray(store.episodes),
  events: toArray(store.events),
  decisions: toArray(store.decisions),
  effectiveness: toArray(store.effectiveness),
  knowledgeItems: toArray(store.knowledgeItems),
});

const getReadCache = () => {
  if (!globalThis[HCM_READ_CACHE_KEY]) {
    globalThis[HCM_READ_CACHE_KEY] = { file: '', mtimeMs: -1, size: -1, store: null };
  }
  return globalThis[HCM_READ_CACHE_KEY];
};

const readStore = ({ cached = false } = {}) => {
  try {
    const file = dataFilePath();
    if (!fs.existsSync(file)) return normalizeStore(inMemoryStore);
    const stat = fs.statSync(file);
    const cache = getReadCache();
    if (
      cached &&
      cache.store &&
      cache.file === file &&
      cache.mtimeMs === stat.mtimeMs &&
      cache.size === stat.size
    ) {
      return cache.store;
    }

    const store = normalizeStore(JSON.parse(fs.readFileSync(file, 'utf-8')));
    if (cached) {
      cache.file = file;
      cache.mtimeMs = stat.mtimeMs;
      cache.size = stat.size;
      cache.store = store;
    }
    return store;
  } catch {
    return normalizeStore(inMemoryStore);
  }
};

const writeStore = (store) => {
  const normalized = normalizeStore(store);
  inMemoryStore.episodes = normalized.episodes;
  inMemoryStore.events = normalized.events;
  inMemoryStore.decisions = normalized.decisions;
  inMemoryStore.effectiveness = normalized.effectiveness;

  const file = dataFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  const stat = fs.statSync(file);
  const cache = getReadCache();
  cache.file = file;
  cache.mtimeMs = stat.mtimeMs;
  cache.size = stat.size;
  cache.store = normalized;
  return clone(normalized);
};

const pickPath = (source, paths) => {
  for (const pathExpression of paths) {
    const value = pathExpression
      .split('.')
      .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const extractMetrics = (payload = {}) => {
  const source = toObject(
    firstPresent(
      payload.metrics,
      payload.oee,
      payload.globalOEE,
      payload.globalOee,
      payload.contextSnapshot?.metrics,
      payload.contextSnapshot?.globalOEE,
      payload.contextSnapshot?.systemAnalytics?.globalOEE,
      payload.contextSnapshot?.analytics?.globalOEE
    )
  );

  return {
    availability: toFiniteNumber(firstPresent(payload.availability, source.availability)),
    performance: toFiniteNumber(firstPresent(payload.performance, source.performance)),
    quality: toFiniteNumber(firstPresent(payload.quality, source.quality)),
    oee: toFiniteNumber(firstPresent(payload.oee, payload.globalOEE, payload.globalOee, source.oee, source.current)),
  };
};

const inferEpisodeTriggers = (payload = {}) => {
  const metrics = extractMetrics(payload);
  const targetOEE = toFiniteNumber(firstPresent(payload.targetOEE, payload.targetOee), 0.85);
  const context = toObject(payload.contextSnapshot ?? payload);
  const risk = safeText(
    firstPresent(payload.risk, payload.riskLevel, context.risk, context.riskLevel, context.analytics?.riskLevel)
  ).toLowerCase();
  const recommendation = firstPresent(
    payload.recommendation,
    context.recommendation,
    context.systemReasoning?.recommendation,
    context.analytics?.recommendation
  );
  const targetCps = safeText(
    firstPresent(
      payload.targetCps,
      payload.cpsId,
      context.targetCps,
      context.criticalCpsId,
      context.analytics?.criticalCPS?.cpsId,
      context.analytics?.criticalCps?.cpsId
    )
  ).toLowerCase();
  const triggers = [];

  if (metrics.oee !== null && targetOEE !== null && metrics.oee < targetOEE) triggers.push('oee_below_target');
  if (risk === 'high') triggers.push('high_risk');
  if (recommendation) triggers.push('local_recommendation');
  if (targetCps) triggers.push('target_cps_identified');

  return {
    trigger: safeText(payload.trigger, triggers[0] || ''),
    triggerReasons: triggers,
    metrics,
    targetOEE,
    risk,
    recommendation,
    targetCps,
  };
};

const markTimedOutEpisodes = (store, options = {}) => {
  const timeoutMs = toFiniteNumber(options.timeoutMs ?? process.env.HCM_EPISODE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const now = Date.now();
  let changed = false;
  const feedbackEpisodeIds = new Set(
    store.events.filter((event) => event.eventType === 'feedback').map((event) => event.episodeId)
  );
  const effectivenessEpisodeIds = new Set(store.effectiveness.map((item) => item.episodeId));

  store.episodes = store.episodes.map((episode) => {
    if (episode.status !== 'open') return episode;
    const isExpired = now - Date.parse(episode.startedAt) > timeoutMs;
    if (isExpired && !feedbackEpisodeIds.has(episode.episodeId) && !effectivenessEpisodeIds.has(episode.episodeId)) {
      changed = true;
      return { ...episode, status: 'timeout', closedAt: nowIso() };
    }
    return episode;
  });
  return changed;
};

const getEpisodeParts = (store, episodeId) => ({
  episode: store.episodes.find((episode) => episode.episodeId === episodeId) || null,
  events: store.events.filter((event) => event.episodeId === episodeId),
  decisions: store.decisions.filter((decision) => decision.episodeId === episodeId),
  effectiveness: store.effectiveness.filter((item) => item.episodeId === episodeId),
});

const getCompleteEpisode = (store, episodeId) => {
  const parts = getEpisodeParts(store, episodeId);
  if (!parts.episode) return null;
  return {
    ...parts.episode,
    chain: {
      initialContext: parts.episode.contextSnapshot,
      events: parts.events,
      decisions: parts.decisions,
      feedback: parts.events.filter((event) => event.eventType === 'feedback'),
      effectiveness: parts.effectiveness,
    },
    events: parts.events,
    decisions: parts.decisions,
    effectiveness: parts.effectiveness,
    knowledgeItems: store.knowledgeItems.filter((item) => item.episodeId === episodeId),
  };
};

const normalizeCpsId = (value) =>
  safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(cps)0+/, '$1');

const stripVolatileFields = (value) => {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      if (['ts', 'timestamp', 'generatedAt', 'lastUpdate', 'updatedAt'].includes(key)) return acc;
      acc[key] = stripVolatileFields(value[key]);
      return acc;
    }, {});
};

const stableStringify = (value) => JSON.stringify(stripVolatileFields(value ?? {}));

const makeKnowledgeSignature = ({ cpsId, source, originalKnowledge }) =>
  crypto
    .createHash('sha256')
    .update(`${normalizeCpsId(cpsId)}|${safeText(source, 'cps')}|${stableStringify(originalKnowledge)}`)
    .digest('hex');

const buildOriginalKnowledge = (payload = {}) => {
  const original = toObject(payload.originalKnowledge);
  if (Object.keys(original).length) return clone(original);

  return clone({
    learning: payload.learning,
    reasoning: payload.reasoning,
    evidence: payload.evidence,
    recommendation: payload.recommendation,
    pattern: payload.pattern ?? payload.learning?.pattern ?? payload.learning?.learned,
    dominantLoss: payload.dominantLoss ?? payload.reasoning?.dominantLoss,
    probableCause: payload.probableCause ?? payload.reasoning?.probableCause,
    forecast: payload.forecast ?? payload.prediction,
    anomaly: payload.anomaly,
    drift: payload.drift ?? payload.learning?.driftScore,
    governableAction: payload.governableAction ?? payload.reasoning?.governableAction ?? payload.learning?.governableAction,
    variation: payload.variation ?? payload.reasoning?.variation ?? payload.learning?.variation,
    requestedValue: payload.requestedValue ?? payload.reasoning?.requestedValue ?? payload.learning?.requestedValue,
    unit: payload.unit ?? payload.reasoning?.unit ?? payload.learning?.unit,
  });
};

const getKnowledgeItem = (store, knowledgeId) =>
  store.knowledgeItems.find((item) => item.knowledgeId === knowledgeId) || null;

export const openEpisode = (payload = {}, options = {}) => {
  const store = readStore();
  if (markTimedOutEpisodes(store, options)) writeStore(store);
  const inferred = inferEpisodeTriggers(payload);

  if (!inferred.trigger) {
    const error = new Error('Episode was not opened because no local HCM trigger was detected.');
    error.status = 422;
    error.details = { expectedTriggers: ['oee_below_target', 'high_risk', 'local_recommendation', 'target_cps_identified'] };
    throw error;
  }

  const existing = store.episodes.find(
    (episode) => episode.status === 'open' && episode.targetCps === inferred.targetCps && episode.trigger === inferred.trigger
  );

  if (existing) {
    const updated = {
      ...existing,
      metrics: inferred.metrics,
      oee: inferred.metrics.oee ?? existing.oee,
      targetOEE: inferred.targetOEE ?? existing.targetOEE,
      contextSnapshot: { ...toObject(existing.contextSnapshot), ...toObject(payload.contextSnapshot ?? payload) },
      updatedAt: nowIso(),
    };
    store.episodes = store.episodes.map((episode) => (episode.episodeId === existing.episodeId ? updated : episode));
    writeStore(store);
    return { episode: getCompleteEpisode(store, updated.episodeId), reused: true };
  }

  const episode = {
    episodeId: makeId('hcm_episode'),
    status: 'open',
    startedAt: nowIso(),
    closedAt: null,
    trigger: inferred.trigger,
    triggerReasons: inferred.triggerReasons,
    source: safeText(payload.source, 'acsm1'),
    targetCps: inferred.targetCps,
    asset: safeText(payload.asset || payload.assetName || payload.contextSnapshot?.asset),
    metrics: inferred.metrics,
    oee: inferred.metrics.oee,
    targetOEE: inferred.targetOEE,
    risk: inferred.risk,
    recommendation: safeText(inferred.recommendation),
    contextSnapshot: clone(payload.contextSnapshot ?? payload),
  };

  store.episodes.push(episode);
  writeStore(store);
  return { episode: getCompleteEpisode(store, episode.episodeId), reused: false };
};

export const registerEvent = (payload = {}) => {
  const store = readStore();
  const episodeId = safeText(payload.episodeId);
  const rawSource = safeText(payload.source, 'acsm1').toLowerCase();
  const source = VALID_EVENT_SOURCES.has(rawSource) ? rawSource : 'acsm1';
  const eventType = safeText(payload.eventType).toLowerCase();

  if (!episodeId || !store.episodes.some((episode) => episode.episodeId === episodeId)) {
    const error = new Error('A valid episodeId is required to register an HCM event.');
    error.status = 404;
    throw error;
  }
  if (!VALID_EVENT_TYPES.has(eventType)) {
    const error = new Error('Invalid local HCM eventType.');
    error.status = 400;
    throw error;
  }

  const event = {
    eventId: makeId('hcm_event'),
    episodeId,
    timestamp: safeText(payload.timestamp, nowIso()),
    source,
    eventType,
    content: clone(payload.content ?? {}),
  };

  store.events.push(event);
  writeStore(store);
  return { event, episode: getCompleteEpisode(store, episodeId) };
};

export const registerDecision = (payload = {}) => {
  const store = readStore();
  const episodeId = safeText(payload.episodeId);
  if (!episodeId || !store.episodes.some((episode) => episode.episodeId === episodeId)) {
    const error = new Error('A valid episodeId is required to register an HCM decision.');
    error.status = 404;
    throw error;
  }

  const decision = {
    decisionId: makeId('hcm_decision'),
    episodeId,
    timestamp: safeText(payload.timestamp, nowIso()),
    decisionSource: safeText(payload.decisionSource || payload.source, 'acsm1'),
    targetCps: safeText(payload.targetCps ?? payload.cpsId),
    action: safeText(payload.action ?? payload.strategy, 'unspecified_action'),
    recommendation: safeText(payload.recommendation),
    rationale: safeText(payload.rationale),
    expectedGain: toFiniteNumber(payload.expectedGain, null),
  };

  store.decisions.push(decision);
  store.events.push({ eventId: makeId('hcm_event'), episodeId, timestamp: decision.timestamp, source: 'acsm1', eventType: 'decision', content: clone(decision) });
  writeStore(store);
  return { decision, episode: getCompleteEpisode(store, episodeId) };
};

const classifyEffectiveness = (gain, threshold = DEFAULT_PARTIAL_GAIN_THRESHOLD) => {
  if (gain === null) return 'unknown';
  if (gain >= threshold) return 'effective';
  if (gain > 0) return 'partially_effective';
  return 'ineffective';
};

const buildExperienceLearned = ({ result, oeeGain, availabilityGain, targetCps }) => {
  if (result === 'effective') return `This intervention improved availability and increased the local OEE by ${((oeeGain ?? 0) * 100).toFixed(1)}%.`;
  if (result === 'partially_effective') return `This recommendation produced limited measurable improvement for ${safeText(targetCps, 'the target CPS')}.`;
  if (result === 'ineffective') return 'This recommendation did not produce measurable improvement.';
  if (availabilityGain !== null) return `Availability changed by ${(availabilityGain * 100).toFixed(1)}%; more feedback is required before reusing this strategy.`;
  return 'No operational feedback has been recorded yet for this episode.';
};

export const registerEffectiveness = (payload = {}) => {
  const store = readStore();
  const episodeId = safeText(payload.episodeId);
  const episode = store.episodes.find((item) => item.episodeId === episodeId);
  if (!episode) {
    const error = new Error('A valid episodeId is required to register effectiveness.');
    error.status = 404;
    throw error;
  }

  const before = extractMetrics({
    metrics: payload.beforeMetrics,
    globalOEE: payload.beforeGlobalOEE,
    availability: payload.beforeAvailability,
    performance: payload.beforePerformance,
    quality: payload.beforeQuality,
  });
  const after = extractMetrics({
    metrics: payload.afterMetrics ?? payload.feedback,
    globalOEE: payload.afterGlobalOEE ?? payload.feedback?.globalOEE,
    availability: payload.afterAvailability ?? payload.feedback?.availability,
    performance: payload.afterPerformance ?? payload.feedback?.performance,
    quality: payload.afterQuality ?? payload.feedback?.quality,
  });
  before.oee = before.oee ?? toFiniteNumber(payload.beforeGlobalOEE, episode.oee);
  after.oee = after.oee ?? toFiniteNumber(payload.afterGlobalOEE ?? payload.feedback?.globalOEE);

  if (after.oee === null) {
    const error = new Error('A valid afterGlobalOEE or afterMetrics.oee is required to register HCM effectiveness.');
    error.status = 400;
    throw error;
  }

  const gains = {
    availabilityGain: before.availability !== null && after.availability !== null ? round(after.availability - before.availability) : null,
    performanceGain: before.performance !== null && after.performance !== null ? round(after.performance - before.performance) : null,
    qualityGain: before.quality !== null && after.quality !== null ? round(after.quality - before.quality) : null,
    oeeGain: before.oee !== null && after.oee !== null ? round(after.oee - before.oee) : null,
    healthChange: toFiniteNumber(payload.healthChange, null),
  };
  const threshold = toFiniteNumber(payload.partialGainThreshold, DEFAULT_PARTIAL_GAIN_THRESHOLD);
  const result = VALID_EFFECTIVENESS.has(payload.result) ? payload.result : classifyEffectiveness(gains.oeeGain, threshold);
  const experienceLearned = safeText(payload.experienceLearned, buildExperienceLearned({ result, oeeGain: gains.oeeGain, availabilityGain: gains.availabilityGain, targetCps: episode.targetCps }));
  const timestamp = safeText(payload.timestamp, nowIso());
  const effectiveness = {
    effectivenessId: makeId('hcm_effectiveness'),
    episodeId,
    timestamp,
    beforeMetrics: before,
    afterMetrics: after,
    beforeGlobalOEE: before.oee,
    afterGlobalOEE: after.oee,
    globalOEEGain: gains.oeeGain,
    ...gains,
    result,
    experienceLearned,
    notes: safeText(payload.notes),
  };

  if (payload.feedback !== undefined || payload.afterGlobalOEE !== undefined || payload.afterMetrics !== undefined) {
    store.events.push({ eventId: makeId('hcm_event'), episodeId, timestamp, source: safeText(payload.feedbackSource, 'acsm1').toLowerCase(), eventType: 'feedback', content: clone(payload.feedback ?? { beforeMetrics: before, afterMetrics: after, notes: effectiveness.notes }) });
  }
  store.events.push({ eventId: makeId('hcm_event'), episodeId, timestamp, source: 'hcm', eventType: 'effectiveness', content: clone(effectiveness) });
  store.events.push({ eventId: makeId('hcm_event'), episodeId, timestamp, source: 'hcm', eventType: 'experience_learned', content: { experienceLearned, result } });

  store.effectiveness = [...store.effectiveness.filter((item) => item.episodeId !== episodeId), effectiveness];
  store.episodes = store.episodes.map((item) =>
    item.episodeId === episodeId ? { ...item, status: VALID_EPISODE_STATUS.has(payload.status) ? payload.status : 'closed', closedAt: nowIso() } : item
  );
  writeStore(store);
  return { effectiveness, episode: getCompleteEpisode(store, episodeId) };
};

export const registerKnowledgeItem = (payload = {}) => {
  const store = readStore();
  const originalKnowledge = buildOriginalKnowledge(payload);
  const cpsId = normalizeCpsId(payload.cpsId || originalKnowledge.cpsId);
  const source = safeText(payload.source, 'cps');

  if (!cpsId) {
    const error = new Error('cpsId is required to register a knowledge item.');
    error.status = 400;
    throw error;
  }
  if (!Object.keys(toObject(originalKnowledge)).length) {
    const error = new Error('originalKnowledge is required to register a knowledge item.');
    error.status = 400;
    throw error;
  }

  const contentSignature = makeKnowledgeSignature({ cpsId, source, originalKnowledge });
  const existing = store.knowledgeItems.find(
    (item) => item.cpsId === cpsId && item.source === source && item.contentSignature === contentSignature
  );

  if (existing) {
    const updated = {
      ...existing,
      episodeId: existing.episodeId || safeText(payload.episodeId),
      lastSeenAt: nowIso(),
      seenCount: (existing.seenCount || 1) + 1,
    };
    store.knowledgeItems = store.knowledgeItems.map((item) =>
      item.knowledgeId === existing.knowledgeId ? updated : item
    );
    writeStore(store);
    return { knowledgeItem: clone(updated), reused: true };
  }

  const createdAt = safeText(payload.createdAt || payload.timestamp, nowIso());
  const knowledgeItem = {
    knowledgeId: `knowledge_${crypto.randomUUID()}`,
    cpsId,
    source,
    timestamp: safeText(payload.timestamp, createdAt),
    createdAt,
    originalKnowledge,
    contentSignature,
    episodeId: safeText(payload.episodeId),
    humanCuration: null,
    curationHistory: [],
    seenCount: 1,
    lastSeenAt: createdAt,
  };

  store.knowledgeItems.push(knowledgeItem);
  writeStore(store);
  return { knowledgeItem: clone(knowledgeItem), reused: false };
};

export const listKnowledgeItems = (filters = {}) => {
  const store = readStore({ cached: true });
  const cpsId = normalizeCpsId(filters.cpsId);
  const items = store.knowledgeItems
    .filter((item) => !cpsId || item.cpsId === cpsId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(clone);
  return applyLimit(items, filters.limit);
};

export const getKnowledgeItemById = (knowledgeId) => {
  const store = readStore({ cached: true });
  return clone(getKnowledgeItem(store, safeText(knowledgeId)));
};

export const curateKnowledgeItem = (knowledgeId, payload = {}) => {
  const immutableAttempt = Object.keys(toObject(payload)).filter((key) => IMMUTABLE_KNOWLEDGE_FIELDS.has(key));
  if (immutableAttempt.length) {
    const error = new Error('Curation cannot modify immutable knowledge fields.');
    error.status = 400;
    error.details = { immutableFields: immutableAttempt };
    throw error;
  }

  const store = readStore();
  const id = safeText(knowledgeId);
  const existing = getKnowledgeItem(store, id);
  if (!existing) {
    const error = new Error('Knowledge item not found.');
    error.status = 404;
    throw error;
  }

  const status = safeText(payload.status).toUpperCase();
  const comment = safeText(payload.comment);
  if (!VALID_CURATION_STATUS.has(status)) {
    const error = new Error('Invalid curation status.');
    error.status = 400;
    error.details = { allowed: [...VALID_CURATION_STATUS] };
    throw error;
  }
  if (['ANNOTATED', 'REJECTED'].includes(status) && !comment) {
    const error = new Error('A comment is required for ANNOTATED or REJECTED curation.');
    error.status = 400;
    throw error;
  }

  const curation = {
    status,
    comment,
    curatedBy: safeText(payload.curatedBy, 'human-operator'),
    curatedAt: nowIso(),
  };
  const updated = {
    ...existing,
    humanCuration: curation,
    curationHistory: [...toArray(existing.curationHistory), curation],
  };

  store.knowledgeItems = store.knowledgeItems.map((item) => (item.knowledgeId === id ? updated : item));

  if (updated.episodeId && store.episodes.some((episode) => episode.episodeId === updated.episodeId)) {
    store.events.push({
      eventId: makeId('hcm_event'),
      episodeId: updated.episodeId,
      timestamp: curation.curatedAt,
      source: 'hcm',
      eventType: 'knowledge_curated',
      content: {
        knowledgeId: updated.knowledgeId,
        cpsId: updated.cpsId,
        curationStatus: curation.status,
        comment: curation.comment,
        curatedBy: curation.curatedBy,
        curatedAt: curation.curatedAt,
        episodeId: updated.episodeId,
      },
    });
  }

  writeStore(store);
  return { knowledgeItem: clone(updated), curation };
};

export const listEpisodes = (filters = {}) => {
  const cachedStore = readStore({ cached: true });
  const store = {
    ...cachedStore,
    episodes: cachedStore.episodes.map((episode) => ({ ...episode })),
  };
  markTimedOutEpisodes(store, filters);
  const status = safeText(filters.status).toLowerCase();
  const episodes = store.episodes
    .filter((episode) => !status || episode.status === status)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return applyLimit(episodes, filters.limit);
};

export const getEpisode = (episodeId) => {
  const cachedStore = readStore({ cached: true });
  const store = {
    ...cachedStore,
    episodes: cachedStore.episodes.map((episode) => ({ ...episode })),
  };
  markTimedOutEpisodes(store);
  return getCompleteEpisode(store, episodeId);
};

export const listEffectiveness = (filters = {}) => {
  const store = readStore({ cached: true });
  const effectiveness = [...store.effectiveness].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
  );
  return applyLimit(effectiveness, filters.limit);
};

export const cognitiveEpisodicMemoryService = {
  openEpisode,
  registerEvent,
  registerDecision,
  registerEffectiveness,
  registerKnowledgeItem,
  listKnowledgeItems,
  getKnowledgeItemById,
  curateKnowledgeItem,
  listEpisodes,
  getEpisode,
  listEffectiveness,
};
