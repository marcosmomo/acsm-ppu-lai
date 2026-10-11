'use client';

import React, {
  createContext,
  useState,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import {
  filterContributionRanking,
  filterManagedArrayByCps,
  getActiveAcsmConfig,
  keepManagedValue,
  normalizeCpsId,
  resolveCpsDisplayName,
} from '../lib/acsm/config';
import {
  sanitizeTextDeep,
  sanitizeTextEncoding,
  sanitizeTextList,
} from '../lib/text/sanitizeTextEncoding';
import {
  GOVERNANCE_STATUS,
  buildGovernanceProfile,
  extractGovernableRecommendation,
  normalizeGovernanceStatus,
} from '../lib/governance/policies';
import {
  applyPhysicalStatus,
  applyRememberedRuntimeMode,
  hasIndependentPhysicalOperationMode,
  operationalDataForAcsmState,
  isPhysicalCps,
  mergeNonStatusOperationalData,
} from '../lib/acsm/cpsOperationMode.mjs';
import {
  applyCpsLai2PhysicalOperationMode,
  getCpsLai2PhysicalOperationMode,
  isCpsLai2SnapshotEquivalent,
  mergeCpsTelemetry,
} from '../lib/acsm/cpsTelemetry.mjs';
import { deriveCpsLai3PhysicalOperationMode } from '../lib/acsm/cpsLai3OperationMode.mjs';
import { publishUnplugNotificationIfAvailable } from '../lib/acsm/unplugNotification.mjs';
import {
  buildCpsLai2TechnicalHealth,
  buildCpsLai3TechnicalHealth,
  buildCpsOperationalHealth,
  publishCpsOperationalHealth,
} from '../lib/acsm/cpsOperationalHealth.mjs';
import {
  CPSLAI1_LIFECYCLE_TOPIC,
  buildCpsLai1LifecyclePayload,
  canTransitionCpsLai1Lifecycle,
  normalizeRegisteredCpsLifecycle,
  shouldPublishCpsLai1Lifecycle,
} from '../lib/acsm/cpsLifecycleMqtt.mjs';
const CPSContext = createContext(undefined);
const ACTIVE_ACSM = getActiveAcsmConfig();
const ACSM_TOPICS = ACTIVE_ACSM.topics;
const LEVEL2_INTELLIGENCE_TOPIC =
  ACSM_TOPICS.level2Intelligence || `${ACTIVE_ACSM.id}/level2/intelligence`;
const LOCAL_ADAPTIVE_INTELLIGENCE_TOPIC =
  ACSM_TOPICS.localAdaptiveIntelligence || `${ACTIVE_ACSM.id}/local/adaptive`;
const SERVICE_ADAPTIVE_INTELLIGENCE_TOPIC = '';
const LEVEL3_INPUT_TOPICS = [];
const LEVEL2_INTELLIGENCE_TOPICS = [
  'acsm1/level2/intelligence',
];
const AI_ENRICHED_ANALYTICS_TOPIC = 'acsm1/+/analytics/enriched';
const COORDINATOR_ACSM_IDS = ['acsm1'];
const COORDINATOR_REMOTE_TOPICS = [];
const HCM_API_BASE = '/api/hcm';
const GOVERNANCE_API_BASE = '/api/governance';
const emptyMultiAcsmInputs = () => ({
  acsm1: null,
});
const emptyCoordinatorSnapshots = () => ({
  acsm1: null,
});
const buildLevel3LocalContribution = (payload = {}) => payload;
const buildLevel3OutputSet = (payload = {}) => payload;
const createLevel3CollaborativeLearningService = () => ({
  ingest: () => null,
  getState: () => ({}),
  reset: () => {},
});
const createLevel3PublisherService = () => ({
  publish: () => Promise.resolve(null),
  buildPackage: (payload = {}) => payload,
});
const createSupplyChainCoordinatorService = () => ({
  update: () => null,
  ingest: () => null,
  getState: () => ({}),
});
const createSupplyChainPublisherService = () => ({
  publish: () => Promise.resolve(null),
});
const createStableSignature = (value) => {
  const seen = new WeakSet();
  return JSON.stringify(value || {}, (key, item) => {
    if (['timestamp', 'ts', 'generatedAt', 'lastUpdate', 'receivedAt'].includes(key)) {
      return undefined;
    }
    if (item && typeof item === 'object') {
      if (seen.has(item)) return undefined;
      seen.add(item);
    }
    return item;
  });
};
const sanitizeManagedText = (value) => {
  if (value === undefined || value === null) return value ?? null;
  return sanitizeTextEncoding(value, { fallback: '' })
    .replace(/cps[\s_-]*0*\d+/gi, (match) => keepManagedValue(match, ACTIVE_ACSM) || '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};
const normalizeManagedReferenceObject = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    return keepManagedValue(value, ACTIVE_ACSM);
  }
  const cpsId = keepManagedValue(
    value?.cpsId || value?.id || value?.baseTopic || value?.cps,
    ACTIVE_ACSM
  );
  if (!cpsId) return null;
  return {
    ...value,
    cpsId,
  };
};
const normalizeManagedArrayEntries = (items) =>
  filterManagedArrayByCps(items, ACTIVE_ACSM).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return typeof item === 'string' ? sanitizeManagedText(item) : item;
    }
    return {
      ...item,
      ...(item?.cpsId !== undefined ? { cpsId: keepManagedValue(item.cpsId, ACTIVE_ACSM) } : {}),
      ...(item?.id !== undefined && keepManagedValue(item.id, ACTIVE_ACSM)
        ? { id: keepManagedValue(item.id, ACTIVE_ACSM) }
        : {}),
      ...(item?.sourceCps !== undefined && keepManagedValue(item.sourceCps, ACTIVE_ACSM)
        ? { sourceCps: keepManagedValue(item.sourceCps, ACTIVE_ACSM) }
        : {}),
      ...(item?.targetCps !== undefined && keepManagedValue(item.targetCps, ACTIVE_ACSM)
        ? { targetCps: keepManagedValue(item.targetCps, ACTIVE_ACSM) }
        : {}),
      ...(item?.relatedCps !== undefined
        ? {
            relatedCps: Array.isArray(item.relatedCps)
              ? item.relatedCps
                  .map((entry) => keepManagedValue(entry, ACTIVE_ACSM))
                  .filter(Boolean)
              : keepManagedValue(item.relatedCps, ACTIVE_ACSM),
          }
        : {}),
    };
  });
const normalizeSystemAnalytics = (payload) => {
  const p = payload || {};
  const criticalCps = keepManagedValue(
    p.criticalCps || p.criticalCPS?.cpsId || p.dominantCps || p.highestLossCps,
    ACTIVE_ACSM
  );
  const currentBottleneck = keepManagedValue(
    p.currentBottleneck || p.bottleneckCps || p.bottleneck?.cpsId || p.bottleneck,
    ACTIVE_ACSM
  );
  const dominantCps = keepManagedValue(
    p.dominantCps || p.criticalCps || p.criticalCPS?.cpsId || p.highestLossCps,
    ACTIVE_ACSM
  );
  const cpsContributionRanking = (p.cpsContributionRanking || p.contributionRanking || [])
    .map((item) => ({
      ...item,
      cpsId: normalizeCpsId(item?.cpsId || item?.id || item?.baseTopic || item?.cps),
      cpsName: resolveCpsDisplayName(
        item?.cpsId || item?.id || item?.baseTopic || item?.cps,
        [],
        item?.cpsName || item?.name
      ),
    }))
    .filter((item) => item?.cpsId);
  const criticalityRanking = filterContributionRanking(
    p.criticalityRanking || p.criticality || [],
    ACTIVE_ACSM
  );
  const dominantLosses = normalizeManagedArrayEntries(p.dominantLosses || []);
  const crossCpsPatterns = normalizeManagedArrayEntries(
    p.crossCpsPatterns || p.systemEvidence?.crossCpsPatterns || p.evidence?.crossCpsPatterns || []
  );
  const riskDrivers = normalizeManagedArrayEntries(
    p.riskDrivers || p.systemEvidence?.riskDrivers || p.evidence?.riskDrivers || []
  );
  const dominantSignals = normalizeManagedArrayEntries(
    p.systemEvidence?.dominantSignals || p.evidence?.dominantSignals || []
  );
  const supportingSignals = normalizeManagedArrayEntries(p.supportingSignals || []);
  const systemEvidence = {
    ...sanitizeTextDeep(p.systemEvidence || {}),
    dominantSignals: sanitizeTextList(dominantSignals),
    crossCpsPatterns: sanitizeTextList(crossCpsPatterns),
    riskDrivers: sanitizeTextList(riskDrivers),
  };
  const payloadActionPlan = sanitizeTextDeep(p.actionPlan || {});
  const fallbackActionPlan = buildFallbackActionPlan(p, criticalCps, currentBottleneck);
  const actionPlan = {
    ...fallbackActionPlan,
    ...payloadActionPlan,
    recommendedFocus:
      sanitizeManagedText(payloadActionPlan?.recommendedFocus || fallbackActionPlan?.recommendedFocus) ||
      null,
    targetCps: keepManagedValue(
      payloadActionPlan?.targetCps || fallbackActionPlan?.targetCps,
      ACTIVE_ACSM
    ),
    recommendation: sanitizeManagedText(payloadActionPlan?.recommendation),
    priority:
      sanitizeManagedText(payloadActionPlan?.priority || fallbackActionPlan?.priority) || null,
  };
  return {
    ...sanitizeTextDeep(p),
    criticalCps,
    currentBottleneck,
    bottleneckCps: currentBottleneck,
    dominantCps,
    criticalCPS: normalizeManagedReferenceObject(p.criticalCPS || criticalCps),
    bottleneck: normalizeManagedReferenceObject(p.bottleneck || currentBottleneck),
    cpsContributionRanking,
    criticality: criticalityRanking,
    criticalityRanking,
    dominantLosses,
    crossCpsPatterns,
    riskDrivers,
    supportingSignals,
    systemEvidence,
    explanation: sanitizeManagedText(p.explanation),
    recommendation: sanitizeManagedText(p.recommendation),
    recommendedFocus:
      sanitizeManagedText(keepManagedValue(p.recommendedFocus, ACTIVE_ACSM)) ||
      actionPlan.recommendedFocus ||
      null,
    actionPlan,
    coordinatorOutput: p.coordinatorOutput
      ? {
          ...sanitizeTextDeep(p.coordinatorOutput),
          criticalCPS: criticalCps,
          recommendation: sanitizeManagedText(p.coordinatorOutput?.recommendation),
          explanation: sanitizeManagedText(p.coordinatorOutput?.explanation),
        }
      : p.coordinatorOutput,
    evidence: {
      ...sanitizeTextDeep(p.evidence || {}),
      dominantSignals: sanitizeTextList(dominantSignals),
      crossCpsPatterns: sanitizeTextList(crossCpsPatterns),
      riskDrivers: sanitizeTextList(riskDrivers),
    },
  };
};

const hasKeys = (obj) =>
  !!obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0;

const hasItems = (arr) => Array.isArray(arr) && arr.length > 0;
const isPlainObject = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const mergeDefinedDeep = (existing, incoming) => {
  if (incoming === undefined || incoming === null) return existing ?? null;

  if (Array.isArray(incoming)) {
    return incoming;
  }

  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged = { ...existing };

    Object.entries(incoming).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      merged[key] = mergeDefinedDeep(existing?.[key], value);
    });

    return merged;
  }

  if (isPlainObject(incoming)) {
    const merged = {};

    Object.entries(incoming).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      merged[key] = mergeDefinedDeep(undefined, value);
    });

    return merged;
  }

  return incoming;
};

const getCoordinatorAcsmIdFromTopic = (topic = '') => {
  const acsmId = normalizeTopic(topic).match(/^(acsm[123])\//)?.[1];
  return COORDINATOR_ACSM_IDS.includes(acsmId) ? acsmId : null;
};

const getCoordinatorSnapshotPresence = (snapshots = {}) =>
  COORDINATOR_ACSM_IDS.reduce(
    (acc, acsmId) => ({
      ...acc,
      [acsmId]: hasKeys(snapshots?.[acsmId]),
    }),
    {}
  );

const buildCoordinatorSnapshotPatch = ({ acsmId, topic, payload, systemAnalytics } = {}) => {
  const raw =
    payload?.payload && isPlainObject(payload.payload)
      ? payload.payload
      : payload && isPlainObject(payload)
        ? payload
        : {};
  const normalizedTopic = normalizeTopic(topic);
  const sourceAcsm = acsmId || getCoordinatorAcsmIdFromTopic(normalizedTopic) || 'acsm1';
  const hasSystemAnalyticsShape =
    normalizedTopic.endsWith('/oee') ||
    normalizedTopic.includes('/analytics') ||
    hasKeys(raw.systemAnalytics) ||
    hasKeys(raw.analytics) ||
    raw.globalOEE !== undefined ||
    raw.globalSummary !== undefined ||
    raw.plantKnowledge !== undefined;
  const analytics = systemAnalytics || raw.systemAnalytics || raw.analytics || (hasSystemAnalyticsShape ? raw : null);
  const reasoning =
    raw.systemReasoning ||
    raw.globalExecutiveReasoning ||
    raw.reasoning ||
    (normalizedTopic.endsWith('/reasoning') ? raw : null);
  const learning =
    raw.systemLearningModel ||
    raw.level3LearningModel ||
    raw.learning ||
    (normalizedTopic.endsWith('/learning') ? raw : null);
  const knowledge =
    normalizedTopic.includes('/knowledge/') ||
    raw.messageType === 'level3_knowledge_package' ||
    raw.messageType === 'global_supplychain_knowledge'
      ? raw
      : raw.knowledge || raw.knowledgeGlobal || null;
  const timestamp = raw.timestamp || raw.generatedAt || raw.isoDate || new Date().toISOString();
  const ts = Number(raw.ts || Date.parse(timestamp) || Date.now());
  const managedCpsIds =
    raw.managedCpsIds ||
    raw.managedCps ||
    raw.globalSummary?.managedCpsIds ||
    raw.plantKnowledge?.managedCpsIds ||
    [];
  const managedCpsCount = Number(
    raw.managedCpsCount ??
      raw.globalSummary?.managedCpsCount ??
      raw.plantKnowledge?.managedCpsCount ??
      (Array.isArray(managedCpsIds) ? managedCpsIds.length : 0)
  );

  return {
    source: sourceAcsm,
    lastTopic: normalizedTopic || null,
    ts,
    timestamp,
    lastUpdate: timestamp,
    systemAnalytics: analytics && hasKeys(analytics) ? analytics : null,
    reasoning: reasoning && hasKeys(reasoning) ? reasoning : null,
    learning: learning && hasKeys(learning) ? learning : null,
    knowledge: knowledge && hasKeys(knowledge) ? knowledge : null,
    executiveSummary:
      raw.executiveSummary ||
      raw.globalExecutiveReasoning?.executiveInterpretation ||
      raw.systemReasoning?.executiveInterpretation ||
      raw.reasoning?.executiveInterpretation ||
      null,
    cpsManaged: {
      ids: Array.isArray(managedCpsIds) ? managedCpsIds : [],
      count: Number.isFinite(managedCpsCount) ? managedCpsCount : 0,
    },
  };
};

const mergeCoordinatorSnapshot = (existing, incoming) => {
  const merged = mergeDefinedDeep(existing || {}, incoming || {});
  return hasKeys(merged) ? merged : null;
};

const buildCoordinatorPayload = (snapshots = {}) => {
  const coordinatorPayload = COORDINATOR_ACSM_IDS.reduce(
    (acc, acsmId) => ({
      ...acc,
      [acsmId]: snapshots?.[acsmId] && hasKeys(snapshots[acsmId]) ? snapshots[acsmId] : null,
    }),
    {}
  );

  return {
    schemaVersion: '1.0',
    messageType: 'coordinator_supply_chain',
    source: 'acsm1',
    target: 'supply_chain_coordinator',
    ts: Date.now(),
    timestamp: new Date().toISOString(),
    coordinatorPayload,
  };
};

const mergeAnalyticsSection = (existing, incoming) => {
  if (incoming === undefined || incoming === null) return existing ?? null;
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    return {
      ...existing,
      ...incoming,
    };
  }
  return incoming;
};

const mergeCpsAnalyticsEntry = (existing = {}, incoming = {}) => ({
  ...existing,
  ...incoming,
  cpsId: incoming?.cpsId ?? existing?.cpsId ?? null,
  cpsName: incoming?.cpsName ?? existing?.cpsName ?? null,
  oee: mergeAnalyticsSection(existing?.oee, incoming?.oee),
  learning: mergeAnalyticsSection(existing?.learning, incoming?.learning),
  reasoning: mergeAnalyticsSection(existing?.reasoning, incoming?.reasoning),
  statistics: mergeAnalyticsSection(existing?.statistics, incoming?.statistics),
  features: mergeAnalyticsSection(existing?.features, incoming?.features),
  window: mergeAnalyticsSection(existing?.window, incoming?.window),
  totals: mergeAnalyticsSection(existing?.totals, incoming?.totals),
  evidence: mergeAnalyticsSection(existing?.evidence, incoming?.evidence),
  basis: mergeAnalyticsSection(existing?.basis, incoming?.basis),
  timeSeriesFeatures: mergeAnalyticsSection(
    existing?.timeSeriesFeatures,
    incoming?.timeSeriesFeatures
  ),
  ai: mergeAnalyticsSection(existing?.ai, incoming?.ai),
  aiOriginalBlock: mergeAnalyticsSection(existing?.aiOriginalBlock, incoming?.aiOriginalBlock),
  analysisMode: incoming?.analysisMode ?? existing?.analysisMode ?? null,
  aiLastUpdate: incoming?.aiLastUpdate ?? existing?.aiLastUpdate ?? null,
  sourceStatus: incoming?.sourceStatus ?? existing?.sourceStatus ?? null,
  lastUpdate: incoming?.lastUpdate ?? existing?.lastUpdate ?? null,
});

const normalizeEvidenceAgainstBaseline = (raw) => {
  if (!isPlainObject(raw)) return null;

  const normalized = {
    cycleDeltaPct: raw?.cycleDeltaPct ?? raw?.CycleDeltaPct ?? null,
    rpmDeltaPct: raw?.rpmDeltaPct ?? raw?.RPMDeltaPct ?? null,
    torqueDeltaPct: raw?.torqueDeltaPct ?? raw?.TorqueDeltaPct ?? null,
    temperatureDeltaPct:
      raw?.temperatureDeltaPct ?? raw?.TemperatureDeltaPct ?? raw?.tempDeltaPct ?? null,
    tempDeltaPct: raw?.tempDeltaPct ?? raw?.temperatureDeltaPct ?? raw?.TemperatureDeltaPct ?? null,
    oeeDeltaPct: raw?.oeeDeltaPct ?? raw?.OEEDeltaPct ?? null,
  };

  return Object.values(normalized).some((value) => value !== null) ? normalized : raw;
};

const extractLocalBaselineEvidence = (payload) => {
  const candidates = [
    payload?.evidence,
    payload?.basis,
    payload?.learning?.evidence,
    payload?.learning?.basis,
    payload?.learning?.Evidence,
    payload?.learning?.Basis,
    payload?.timeSeriesFeatures?.quickSignals,
    payload?.learning?.timeSeriesFeatures?.quickSignals,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeEvidenceAgainstBaseline(candidate);
    if (normalized) return normalized;
  }

  return null;
};

export const useCPSContext = () => {
  const context = useContext(CPSContext);

  if (!context) {
    throw new Error('useCPSContext must be used within a CPSProvider');
  }

  return context;
};

const DEFAULT_BROKER_URL =
  typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? 'wss://localhost:9001/mqtt'
    : 'ws://localhost:9001/mqtt';

const joinTopic = (base, suffix) =>
  `${String(base).replace(/\/+$/, '')}/${String(suffix).replace(/^\/+/, '')}`;
const isValidMqttTopic = (topic) => typeof topic === 'string' && topic.trim().length > 0;

const COMMAND_TOPIC_SUFFIX = 'cmd';
const DATA_TOPIC_SUFFIX = 'data';
const ACK_TOPIC_SUFFIX = 'ack';
const STATUS_TOPIC_SUFFIX = 'status';
const HEALTH_TOPIC_SUFFIX = 'health';
const ALARM_TOPIC_SUFFIX = 'alarm';
const OEE_TOPIC_SUFFIX = 'oee';
const LEARNING_TOPIC_SUFFIX = 'learning';
const SUPPLY_CHAIN_REASONING_TOPIC = 'supplychain/reasoning';
const LEVEL3_LAST_PUBLISH_AT_KEY = 'level3_last_publish_at';
const LEVEL3_AUTO_PUBLISH_ENABLED_KEY = 'level3_auto_publish_enabled';
const LEVEL3_LAST_PAYLOAD_KEY = 'level3_last_payload';
const SUPPLY_CHAIN_FEEDBACK_GLOBAL_TOPIC =
  ACSM_TOPICS.supplyChainFeedbackGlobal || 'supplychain/feedback/global';
const SUPPLY_CHAIN_FEEDBACK_LOCAL_TOPIC =
  ACSM_TOPICS.supplyChainFeedbackLocal || `supplychain/feedback/${ACTIVE_ACSM.id}`;

const DEBUG_LOG_ALL_TOPICS = true;
const FEATURE_UI_UPDATE_MS = 5000;

const LIFECYCLE_UNPLUG_REQUEST_TOPIC = ACSM_TOPICS.lifecycleUnplugRequest;
const LIFECYCLE_UPDATE_FUNCTIONS_TOPIC = ACSM_TOPICS.lifecycleUpdateFunctions;
const AUTOUNPLUG_DEDUP_MS = 15000;

const MAX_INGESTION_BUFFER = 300;
const MAX_HISTORY_PER_CPS = 500;
const MAX_SYSTEM_EVENTS = 500;
const MAX_SYSTEM_SNAPSHOTS = 500;
const MAX_SYSTEM_LEARNING_HISTORY = 500;
const SYSTEM_LEARNING_WINDOW_SIZE = 6;
const SYSTEM_ANALYTICS_STABILIZATION_MS = 300;
const STABLE_SYSTEM_ANALYTICS_OEE_EPSILON = 0.003;
const STABLE_SYSTEM_ANALYTICS_RATIO_EPSILON = 0.003;
const STABLE_SYSTEM_ANALYTICS_SCORE_EPSILON = 0.01;

const buildFallbackActionPlan = (payload, criticalCps, bottleneckCps) => {
  const targetCps = keepManagedValue(criticalCps || bottleneckCps, ACTIVE_ACSM);
  const mostCriticalAcsm =
    sanitizeManagedText(payload?.mostCriticalAcsm || payload?.criticalCoordinationPoint?.acsmId) ||
    null;
  const propagationRisk = String(
    payload?.propagationRisk ||
      payload?.lossPropagation?.propagationRisk ||
      payload?.lossPropagation?.riskLevel ||
      ''
  ).toLowerCase();

  const fallback = {
    recommendedFocus: mostCriticalAcsm,
    targetCps,
    priority: propagationRisk === 'high' ? 'high' : 'medium',
  };

  return Object.values(fallback).some((value) => value !== null && value !== undefined && value !== '')
    ? fallback
    : {};
};

const normalizeTopic = (t) => String(t || '').replace(/^\/+/, '').replace(/\/+$/, '');

const getLevel2IntelligenceAcsmIdFromTopic = (topic = '') =>
  normalizeTopic(topic).match(/^(acsm[123])\/level2\/intelligence$/)?.[1] || null;

const isLevel2IntelligenceTopic = (topic = '') =>
  Boolean(getLevel2IntelligenceAcsmIdFromTopic(topic));

const getAiEnrichedAnalyticsCpsIdFromTopic = (topic = '') =>
  normalizeCpsId(normalizeTopic(topic).match(/^acsm1\/([^/]+)\/analytics\/enriched$/)?.[1]);

const isAiEnrichedAnalyticsTopic = (topic = '') =>
  Boolean(getAiEnrichedAnalyticsCpsIdFromTopic(topic));

const buildFlatAiAnalysis = (data = {}) => {
  const analysis = {
    summary: data?.summary,
    recommendation: data?.recommendation,
    indicatorInterpretation: data?.indicatorInterpretation,
    temporalDynamics: data?.temporalDynamics,
    riskAssessment: data?.riskAssessment,
    operationalImplication: data?.operationalImplication,
    confidenceNote: data?.confidenceNote,
  };
  return Object.values(analysis).some((value) => value !== undefined && value !== null && value !== '')
    ? analysis
    : null;
};

const normalizeAiAnalysisPayload = (data = {}) => {
  const nested = data?.enrichedAnalysis || data?.ai || data?.analysis || null;
  const analysis = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : buildFlatAiAnalysis(data);

  if (!analysis || typeof analysis !== 'object') return null;

  if (
    data?.quotaExceeded ||
    data?.fallbackReason === 'quota_exhausted' ||
    data?.fallbackReason === 'quota_backoff' ||
    data?.httpStatusCode === 429 ||
    data?.status === 429
  ) {
    return {
      ...analysis,
      summary:
        analysis.summary && analysis.summary !== 'evidence is insufficient'
          ? analysis.summary
          : 'Gemini quota exceeded; fallback analysis shown.',
      confidenceNote:
        analysis.confidenceNote && analysis.confidenceNote !== 'request failed'
          ? analysis.confidenceNote
          : 'Gemini quota/backoff fallback; no live Gemini interpretation was generated for this update.',
    };
  }

  return analysis;
};

const buildAiEnrichedAnalyticsEntry = (existing = {}, cpsId, data = {}) => {
  const incomingAi = normalizeAiAnalysisPayload(data);
  const analysisSource = String(data?.analysisSource || '').toLowerCase();
  const legacyMode = String(data?.analysisMode || '').toLowerCase();
  const isFallback = analysisSource === 'fallback' || legacyMode === 'fallback';
  const updateTimestamp =
    data?.timestamp ||
    (Number.isFinite(Number(data?.ts)) ? new Date(Number(data.ts)).toISOString() : null) ||
    new Date().toISOString();
  const incomingMode = ['full', 'light'].includes(legacyMode) ? legacyMode : 'light';
  const incomingSource = data?.analysisSource || (isFallback ? 'fallback' : 'live');

  const merged = mergeCpsAnalyticsEntry(existing || {}, {
    cpsId,
    ai: incomingAi,
    enrichedAnalysis: incomingAi,
    aiOriginalBlock: data || null,
    analysisMode: incomingMode,
    analysisSource: incomingSource,
    aiLastUpdate: updateTimestamp,
    lastUpdate: updateTimestamp,
  });

  return {
    ...merged,
    ai: incomingAi,
    enrichedAnalysis: incomingAi,
    aiOriginalBlock: data || null,
    aiFallbackLastUpdate: isFallback ? updateTimestamp : existing?.aiFallbackLastUpdate || null,
    aiWasPreservedOnFallback: false,
  };
};

const topicVariants = (t) => {
  const noLead = normalizeTopic(t);
  const withLead = `/${noLead}`;
  return [noLead, withLead];
};

const normalizeUrl = (url) => {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `http://${u}`;
};

const isMaintenanceReason = (reason) => {
  const r = String(reason || '').toLowerCase().trim();
  return [
    'maintenance',
    'manutencao',
    'preventive_maintenance',
    'corrective_maintenance',
    'scheduled_maintenance',
    'unscheduled_maintenance',
  ].includes(r);
};

const safeParseJson = (raw) => {
  try {
    if (raw && typeof raw === 'object' && !ArrayBuffer.isView(raw)) {
      return raw;
    }
    return typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
  } catch {
    return null;
  }
};

const emptySupplyChainFeedback = () => ({
  lastUpdate: null,
  globalAssessment: null,
  globalDirectives: null,
  adaptiveLearning: null,
  adaptiveTimeline: [],
  local: null,
  raw: null,
});

const emptyLocalAdaptiveIntelligence = () => ({
  lastUpdate: null,
  adaptiveLearningLocal: null,
  adaptiveTimelineLocal: [],
  raw: null,
});

const emptyServiceAdaptiveIntelligence = () => ({
  lastUpdate: null,
  adaptiveLearningService: null,
  adaptiveTimelineService: [],
  raw: null,
});

const emptyCpsAdaptiveEntry = () => ({
  lastUpdate: null,
  adaptiveLearningCps: null,
  adaptiveTimelineCps: [],
  raw: null,
});

const normalizeSupplyChainFeedback = (payload = {}, acsmId = ACTIVE_ACSM.id) => {
  if (!payload || typeof payload !== 'object') return emptySupplyChainFeedback();

  const localFeedback = payload?.perACSMFeedback?.[acsmId] || null;

  return {
    globalAssessment: payload.globalAssessment || null,
    globalDirectives: payload.globalDirectives || null,
    adaptiveLearning: payload.adaptiveLearning || null,
    adaptiveTimeline: Array.isArray(payload.adaptiveTimeline) ? payload.adaptiveTimeline : [],
    local: localFeedback,
  };
};

const normalizeSupplyChainPackage = (payload = {}) => ({
  schemaVersion: payload.schemaVersion || '1.0',
  messageType: payload.messageType || 'level3_knowledge_package',
  source: payload.source || 'acsm1',
  target: payload.target || 'supply_chain_coordinator',
  ts: Number(payload.ts || Date.now()),
  timestamp: payload.timestamp || new Date().toISOString(),
  globalOEE: Number(payload.globalOEE || 0),
  trend: payload.trend || 'unknown',
  confidence: Number(payload.confidence || 0),
  riskLevel: payload.riskLevel || 'unknown',
  criticalCPS: {
    cpsId: payload?.criticalCPS?.cpsId || '',
    cpsName: payload?.criticalCPS?.cpsName || '',
    acsmId: payload?.criticalCPS?.acsmId || '',
  },
  learningPattern: payload.learningPattern || '',
  learningConsensus: payload.learningConsensus || '',
  dominantLosses: Array.isArray(payload.dominantLosses) ? payload.dominantLosses : [],
  recommendation: payload.recommendation || '',
  executiveSummary: payload.executiveSummary || '',
  reasoning: {
    primaryIssue: payload?.reasoning?.primaryIssue || '',
    systemState: payload?.reasoning?.systemState || payload?.systemReasoning?.systemState || '',
    dominantLoss: payload?.reasoning?.dominantLoss || payload?.systemReasoning?.dominantLoss || '',
    probableCause:
      payload?.reasoning?.probableCause || payload?.systemReasoning?.probableCause || '',
    trend: payload?.reasoning?.trend || payload?.systemReasoning?.trend || '',
    confidence: Number(
      payload?.reasoning?.confidence ?? payload?.systemReasoning?.confidence ?? payload.confidence ?? 0
    ),
    recommendation:
      payload?.reasoning?.recommendation || payload?.systemReasoning?.recommendation || '',
    activeCriticalZone: payload?.reasoning?.activeCriticalZone || '',
    propagationImpact: payload?.reasoning?.propagationImpact || '',
    decisionContext: payload?.reasoning?.decisionContext || '',
    executiveInterpretation: payload?.reasoning?.executiveInterpretation || '',
  },
  systemLearningModel:
    payload.systemLearningModel && typeof payload.systemLearningModel === 'object'
      ? payload.systemLearningModel
      : null,
  systemEvidence: Array.isArray(payload.systemEvidence) ? payload.systemEvidence : [],
  systemCausality:
    payload.systemCausality && typeof payload.systemCausality === 'object'
      ? payload.systemCausality
      : null,
  criticalityRanking: Array.isArray(payload.criticalityRanking) ? payload.criticalityRanking : [],
  systemAnomaly:
    payload.systemAnomaly && typeof payload.systemAnomaly === 'object'
      ? payload.systemAnomaly
      : null,
  systemForecast:
    payload.systemForecast && typeof payload.systemForecast === 'object'
      ? payload.systemForecast
      : null,
  systemReasoning:
    payload.systemReasoning && typeof payload.systemReasoning === 'object'
      ? payload.systemReasoning
      : null,
  participants: Array.isArray(payload.participants) ? payload.participants : [],
  managedCpsCount: Number(payload.managedCpsCount || 0),
  publisher: {
    acsmId: payload?.publisher?.acsmId || 'acsm1',
    level: payload?.publisher?.level || 'level3',
  },
  multiAcsmInputs:
    payload.multiAcsmInputs && typeof payload.multiAcsmInputs === 'object'
      ? payload.multiAcsmInputs
      : undefined,
  level3LearningModel:
    payload.level3LearningModel && typeof payload.level3LearningModel === 'object'
      ? payload.level3LearningModel
      : undefined,
  globalSystemEvidence: Array.isArray(payload.globalSystemEvidence)
    ? payload.globalSystemEvidence
    : undefined,
  globalSystemCausality:
    payload.globalSystemCausality && typeof payload.globalSystemCausality === 'object'
      ? payload.globalSystemCausality
      : undefined,
  globalCriticalityRanking: Array.isArray(payload.globalCriticalityRanking)
    ? payload.globalCriticalityRanking
    : undefined,
  acsmCriticalityRanking: Array.isArray(payload.acsmCriticalityRanking)
    ? payload.acsmCriticalityRanking
    : undefined,
  globalSystemAnomaly:
    payload.globalSystemAnomaly && typeof payload.globalSystemAnomaly === 'object'
      ? payload.globalSystemAnomaly
      : undefined,
  globalSystemForecast:
    payload.globalSystemForecast && typeof payload.globalSystemForecast === 'object'
      ? payload.globalSystemForecast
      : undefined,
  globalExecutiveReasoning:
    payload.globalExecutiveReasoning && typeof payload.globalExecutiveReasoning === 'object'
      ? payload.globalExecutiveReasoning
      : undefined,
  coordinatorPayload:
    payload.coordinatorPayload && typeof payload.coordinatorPayload === 'object'
      ? payload.coordinatorPayload
      : undefined,
});

const normalizeCoordinatorSupplyChainPayload = (payload = {}) => {
  const coordinatorPayload = COORDINATOR_ACSM_IDS.reduce(
    (acc, acsmId) => ({
      ...acc,
      [acsmId]:
        payload?.coordinatorPayload?.[acsmId] && hasKeys(payload.coordinatorPayload[acsmId])
          ? payload.coordinatorPayload[acsmId]
          : null,
    }),
    {}
  );

  return {
    schemaVersion: '1.0',
    messageType: 'coordinator_supply_chain',
    source: 'acsm1',
    target: 'supply_chain_coordinator',
    ts: Number(payload.ts || Date.now()),
    timestamp: payload.timestamp || new Date().toISOString(),
    coordinatorPayload,
  };
};

const normalizeLevel2AcsmIntelligence = (payload = {}, topic = '') => {
  const topicAcsm = getLevel2IntelligenceAcsmIdFromTopic(topic);
  const rawSource = String(
    payload?.source ||
      payload?.publisher?.acsmId ||
      topicAcsm ||
      ''
  )
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const acsmId = COORDINATOR_ACSM_IDS.includes(rawSource)
    ? rawSource
    : topicAcsm || 'unknown';
  const criticalCPS = payload?.criticalCPS && typeof payload.criticalCPS === 'object'
    ? payload.criticalCPS
    : payload?.criticalCps
      ? { cpsId: payload.criticalCps }
      : {};
  const reasoning = payload?.systemReasoning && typeof payload.systemReasoning === 'object'
    ? payload.systemReasoning
    : payload?.reasoning && typeof payload.reasoning === 'object'
      ? payload.reasoning
      : {};

  return {
    schemaVersion: payload.schemaVersion || '1.0',
    messageType: payload.messageType || 'acsm_level2_intelligence',
    source: acsmId,
    ts: Number(payload.ts || Date.now()),
    timestamp: payload.timestamp || new Date().toISOString(),
    globalOEE: Number(payload.globalOEE || 0),
    trend: payload.trend || reasoning.trend || 'stable',
    confidence: Number(payload.confidence ?? reasoning.confidence ?? 0),
    riskLevel: payload.riskLevel || 'low',
    criticalCPS: {
      cpsId: criticalCPS.cpsId || '',
      cpsName: criticalCPS.cpsName || '',
    },
    learningPattern: payload.learningPattern || '',
    learningConsensus: payload.learningConsensus || '',
    recommendation: payload.recommendation || reasoning.recommendation || '',
    executiveSummary:
      payload.executiveSummary || reasoning.executiveInterpretation || '',
    systemLearningModel:
      payload.systemLearningModel && typeof payload.systemLearningModel === 'object'
        ? payload.systemLearningModel
        : {},
    systemEvidence: Array.isArray(payload.systemEvidence) ? payload.systemEvidence : [],
    systemCausality:
      payload.systemCausality && typeof payload.systemCausality === 'object'
        ? payload.systemCausality
        : {},
    criticalityRanking: Array.isArray(payload.criticalityRanking)
      ? payload.criticalityRanking
      : [],
    systemAnomaly:
      payload.systemAnomaly && typeof payload.systemAnomaly === 'object'
        ? payload.systemAnomaly
        : {},
    systemForecast:
      payload.systemForecast && typeof payload.systemForecast === 'object'
        ? payload.systemForecast
        : {},
    systemReasoning: reasoning || {},
    participants: Array.isArray(payload.participants) ? payload.participants : [],
    managedCpsCount: Number(payload.managedCpsCount || 0),
    publisher: {
      acsmId: payload?.publisher?.acsmId || acsmId,
      level: payload?.publisher?.level || 'level2',
    },
  };
};

const clampArray = (arr, max) => {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
};

const nowTs = () => Date.now();

const toNumber = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const stripKnowledgeVolatileFields = (value) => {
  if (Array.isArray(value)) return value.map(stripKnowledgeVolatileFields);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      if (['ts', 'timestamp', 'generatedAt', 'updatedAt', 'lastUpdate'].includes(key)) return acc;
      acc[key] = stripKnowledgeVolatileFields(value[key]);
      return acc;
    }, {});
};

const stableKnowledgeStringify = (value) =>
  JSON.stringify(stripKnowledgeVolatileFields(value ?? {}));

const makeLocalKnowledgeSignature = ({ cpsId, source, originalKnowledge }) =>
  `${normalizeCpsId(cpsId)}|${String(source || 'cps')}|${stableKnowledgeStringify(originalKnowledge)}`;

const normalizeSnapshotTimestamp = (value) => {
  if (value === undefined || value === null || value === '') return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const isNewerSnapshot = (incomingValue, currentValue) => {
  const incomingTs = normalizeSnapshotTimestamp(incomingValue);
  const currentTs = normalizeSnapshotTimestamp(currentValue);

  if (incomingTs === null) return currentTs === null;
  return currentTs === null || incomingTs > currentTs;
};

const canonicalizeOeeBlock = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const canonicalValue =
    toNumber(source?.oee) ??
    toNumber(source?.value) ??
    toNumber(source?.current) ??
    null;

  return {
    ...source,
    current: canonicalValue,
    oee: canonicalValue,
    value: canonicalValue,
  };
};

const normalizeLocalAnalyticsPayload = (payload, topic) => {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const source = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
  const topicBase = normalizeTopic(topic).split('/')[0] || '';
  const cpsId = normalizeCpsId(source?.cpsId || raw?.cpsId || topicBase);

  if (!cpsId) return null;

  return {
    ...source,
    cpsId,
    cpsName: source?.cpsName || raw?.cpsName || cpsId,
    ts: source?.ts || raw?.ts || Date.now(),
    timestamp: source?.timestamp || raw?.timestamp || null,
    sourceStatus: source?.sourceStatus || source?.status || raw?.sourceStatus || raw?.status || null,
    oee: canonicalizeOeeBlock(
      source?.oee && typeof source.oee === 'object'
        ? {
            ...source.oee,
            availability: source?.oee?.availability ?? source?.availability,
            performance:
              source?.oee?.performance ??
              source?.oee?.performanceDisplay ??
              source?.oee?.performanceAccumulated ??
              source?.performance,
            quality: source?.oee?.quality ?? source?.quality,
          }
        : {
            availability: source?.availability,
            performance: source?.performance,
            quality: source?.quality,
            current: source?.oee,
          }
    ),
    telemetry: {
      pieceCounter:
        toNumber(source?.telemetry?.pieceCounter) ??
        toNumber(source?.production?.pieceCounterAbs) ??
        null,
      cycleTimeMs:
        toNumber(source?.telemetry?.cycleTimeMs) ??
        toNumber(source?.features?.avgCycleTimeMs) ??
        null,
      temperature:
        toNumber(source?.telemetry?.temperature) ??
        toNumber(source?.telemetry?.currentTemperature) ??
        toNumber(source?.features?.avgTemperature) ??
        toNumber(source?.features?.avgTempPontaSolda) ??
        null,
      rpm:
        toNumber(source?.telemetry?.rpm) ??
        toNumber(source?.telemetry?.currentRPM) ??
        toNumber(source?.features?.avgRpm) ??
        toNumber(source?.features?.avgCorrenteArco) ??
        null,
      torque:
        toNumber(source?.telemetry?.torque) ??
        toNumber(source?.telemetry?.currentTorque) ??
        toNumber(source?.features?.avgTorque) ??
        toNumber(source?.features?.avgPressaoGas) ??
        null,
    },
  };
};

const buildStatisticsFromTimeSeriesFeatures = (timeSeriesFeatures) => {
  const summaries =
    timeSeriesFeatures?.summaries && typeof timeSeriesFeatures.summaries === 'object'
      ? timeSeriesFeatures.summaries
      : null;

  if (!summaries) return null;

  const stats = {};
  const addMetric = (metricKey, outputKey) => {
    const source = summaries?.[metricKey];
    if (!source || typeof source !== 'object') return;

    const meanValue = source?.mean ?? null;
    const medianValue = source?.median ?? null;

    if (meanValue !== null) {
      stats[`${outputKey}Mean`] = meanValue;
      stats[`${outputKey}_mean`] = meanValue;
    }

    if (medianValue !== null) {
      stats[`${outputKey}Median`] = medianValue;
      stats[`${outputKey}_median`] = medianValue;
    }
  };

  addMetric('oee', 'oee');
  addMetric('availability', 'availability');
  addMetric('performance', 'performance');
  addMetric('quality', 'quality');
  addMetric('temperature', 'temperature');
  addMetric('cycleTimeMs', 'cycle');

  if (summaries.current) addMetric('current', 'current');
  if (summaries.gasPressure) addMetric('gasPressure', 'gasPressure');
  if (summaries.rpm) addMetric('rpm', 'rpm');
  if (summaries.torque) addMetric('torque', 'torque');

  return Object.keys(stats).length ? stats : null;
};

const normalizeLocalIntelligencePayload = (payload, topic) => {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const source = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
  const topicBase = normalizeTopic(topic).split('/')[0] || '';
  const cpsId = normalizeCpsId(source?.cpsId || source?.baseTopic || raw?.cpsId || topicBase);

  if (!cpsId) return null;

  const learning = source?.learning || source?.analytics?.learning || null;
  const reasoning = source?.reasoning || source?.analytics?.reasoning || null;
  const timeSeriesFeatures =
    source?.timeSeriesFeatures || source?.analytics?.timeSeriesFeatures || null;
  const statistics =
    source?.statistics || buildStatisticsFromTimeSeriesFeatures(timeSeriesFeatures);
  const evidence =
    source?.evidence ||
    source?.analytics?.evidence ||
    learning?.basis ||
    learning?.evidence ||
    timeSeriesFeatures?.quickSignals ||
    null;
  const recommendation =
    source?.recommendation ||
    reasoning?.recommendation ||
    learning?.recommendation ||
    source?.acsmHints?.recommendedAction ||
    null;
  const prediction =
    source?.prediction ||
    source?.forecast ||
    (Array.isArray(source?.acsmHints?.forecastOEE)
      ? { forecastOEE: source.acsmHints.forecastOEE }
      : null);

  return {
    ...source,
    cpsId,
    cpsName: source?.cpsName || raw?.cpsName || cpsId,
    baseTopic: source?.baseTopic || topicBase,
    learning,
    reasoning,
    statistics,
    evidence,
    timeSeriesFeatures,
    prediction,
    recommendation,
    lastUpdate: source?.generatedAt || source?.timestamp || source?.ts || Date.now(),
  };
};

const mean = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const nums = arr.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

const nullableMean = (arr) => {
  const nums = (Array.isArray(arr) ? arr : [])
    .map((value) => toNumber(value, null))
    .filter((value) => Number.isFinite(value));
  return nums.length
    ? Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(4))
    : null;
};

const stddev = (arr) => {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const nums = arr.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (nums.length < 2) return 0;
  const avg = mean(nums);
  const variance = nums.reduce((acc, value) => acc + (value - avg) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const getHistorySeries = (history, key) =>
  (history || [])
    .map((item) => toNumber(item?.[key]))
    .filter((value) => Number.isFinite(value));

const getLinearSlope = (series) => {
  if (!Array.isArray(series) || series.length < 2) return 0;
  const y = series.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (y.length < 2) return 0;
  const n = y.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(y);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const xDelta = i - xMean;
    numerator += xDelta * (y[i] - yMean);
    denominator += xDelta * xDelta;
  }
  if (!denominator) return 0;
  return numerator / denominator;
};

const getSignChanges = (series) => {
  if (!Array.isArray(series) || series.length < 3) return 0;
  let changes = 0;
  let previousSign = 0;
  for (let i = 1; i < series.length; i += 1) {
    const delta = toNumber(series[i], 0) - toNumber(series[i - 1], 0);
    const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (sign && previousSign && sign !== previousSign) changes += 1;
    if (sign) previousSign = sign;
  }
  return changes;
};

const getChronicLossSummary = (recentHistory) => {
  const availabilityMean = mean(getHistorySeries(recentHistory, 'systemAvailability'));
  const performanceMean = mean(getHistorySeries(recentHistory, 'systemPerformance'));
  const qualityMean = mean(getHistorySeries(recentHistory, 'systemQuality'));

  const losses = [
    { key: 'availability', score: clamp01(1 - availabilityMean) },
    { key: 'performance', score: clamp01(1 - performanceMean) },
    { key: 'quality', score: clamp01(1 - qualityMean) },
  ].sort((a, b) => b.score - a.score);

  const dominant = losses[0] || { key: null, score: 0 };
  const chronic = dominant.score >= 0.12 ? dominant.key : null;

  return {
    dominantChronicLoss: chronic,
    lossScores: {
      availability: Number((losses.find((item) => item.key === 'availability')?.score || 0).toFixed(4)),
      performance: Number((losses.find((item) => item.key === 'performance')?.score || 0).toFixed(4)),
      quality: Number((losses.find((item) => item.key === 'quality')?.score || 0).toFixed(4)),
    },
  };
};

const buildSystemLearning = (learningHistory) => {
  const history = Array.isArray(learningHistory) ? learningHistory.filter(Boolean) : [];
  const current = history.at(-1) || null;

  if (!current) {
    return {
      learningState: 'insufficient_history',
      learningPattern: 'insufficient_history',
      confidence: 0,
      globalDriftScore: 0,
      predictedSystemOEE: null,
      dominantChronicLoss: null,
      cpsContributionRanking: [],
      recommendation: 'Collect more OEE history for system-level learning.',
      derivedLearning: {
        pattern: 'insufficient_history',
        confidence: 0,
      },
      systemEvidence: {
        dominantSignals: [],
      },
      learningConsensus: null,
      fleetDriftIndex: 0,
      fleetAnomalyIndex: 0,
      stabilityIndex: null,
      supportingSignals: [],
      riskDrivers: [],
      historySummary: {
        samples: history.length,
      },
    };
  }

  const recentWindow = history.slice(-SYSTEM_LEARNING_WINDOW_SIZE);
  const baselineWindow = history.slice(-12, -SYSTEM_LEARNING_WINDOW_SIZE);
  const fullOeeSeries = getHistorySeries(history, 'systemOEE');
  const recentOeeSeries = getHistorySeries(recentWindow, 'systemOEE');
  const baselineOeeSeries = getHistorySeries(baselineWindow, 'systemOEE');

  const recentMeanOee = mean(recentOeeSeries);
  const baselineMeanOee = baselineOeeSeries.length ? mean(baselineOeeSeries) : recentMeanOee;
  const drift = recentMeanOee - baselineMeanOee;
  const slope = getLinearSlope(recentOeeSeries);
  const volatility = stddev(recentOeeSeries);
  const signChanges = getSignChanges(recentOeeSeries);

  const { dominantChronicLoss, lossScores } = getChronicLossSummary(recentWindow);

  let learningPattern = 'stable_system';
  let learningState = 'stable';

  if (recentOeeSeries.length < 3) {
    learningPattern = 'insufficient_history';
    learningState = 'learning';
  } else if (signChanges >= 2 && volatility >= 0.035) {
    learningPattern = 'unstable_oscillation';
    learningState = 'unstable';
  } else if (drift <= -0.03 || slope <= -0.01) {
    learningPattern = 'degrading_system';
    learningState = 'degrading';
  } else if (drift >= 0.02 || slope >= 0.01) {
    learningPattern = 'recovering_system';
    learningState = 'recovering';
  } else if (dominantChronicLoss === 'availability') {
    learningPattern = 'chronic_availability_loss';
    learningState = 'attention';
  } else if (dominantChronicLoss === 'performance') {
    learningPattern = 'chronic_performance_loss';
    learningState = 'attention';
  } else if (dominantChronicLoss === 'quality') {
    learningPattern = 'chronic_quality_loss';
    learningState = 'attention';
  }

  const lastOee = toNumber(fullOeeSeries.at(-1), toNumber(current.systemOEE, null));
  const prevOee = toNumber(fullOeeSeries.at(-2), lastOee);
  const projectedStep = recentOeeSeries.length >= 2 ? slope : lastOee - prevOee;
  const predictedSystemOEE =
    lastOee === null ? null : Number(clamp01(lastOee + projectedStep).toFixed(4));

  const globalDriftScore = Number(
    clamp01(Math.abs(drift) * 8 + Math.abs(slope) * 10 + volatility * 6).toFixed(4)
  );

  const cpsContributionRanking = (current?.cpsMetrics || [])
    .map((item) => {
      const availabilityLoss = clamp01(1 - toNumber(item?.availability, 0));
      const performanceLoss = clamp01(1 - toNumber(item?.performance, 0));
      const qualityLoss = clamp01(1 - toNumber(item?.quality, 0));
      const oeeLoss = clamp01(1 - toNumber(item?.oee, 0));
      const score = Number(
        (
          oeeLoss * 0.4 +
          availabilityLoss * 0.2 +
          performanceLoss * 0.2 +
          qualityLoss * 0.2
        ).toFixed(4)
      );

      return {
        cpsId: normalizeCpsId(item?.cpsId),
        cpsName: item?.cpsName || null,
        score,
        oee: toNumber(item?.oee, null),
        availability: toNumber(item?.availability, null),
        performance: toNumber(item?.performance, null),
        quality: toNumber(item?.quality, null),
        dominantLoss:
          availabilityLoss >= performanceLoss && availabilityLoss >= qualityLoss
            ? 'availability'
            : performanceLoss >= availabilityLoss && performanceLoss >= qualityLoss
              ? 'performance'
              : 'quality',
      };
    })
    .filter((item) => item?.cpsId)
    .sort((a, b) => b.score - a.score);

  let recommendation =
    'Maintain monitoring of aggregated OEE indicators and preserve current operating discipline.';
  if (learningPattern === 'degrading_system') {
    recommendation =
      'Investigate the recent decline in system OEE and prioritize the CPS with the highest contribution to aggregated loss.';
  } else if (learningPattern === 'recovering_system') {
    recommendation =
      'Preserve the recent recovery actions and verify whether the OEE improvement remains stable over the next window.';
  } else if (learningPattern === 'unstable_oscillation') {
    recommendation =
      'Reduce variability in handoff and execution because the system OEE is oscillating across consecutive windows.';
  } else if (learningPattern === 'chronic_availability_loss') {
    recommendation =
      'Availability is the persistent systemic loss driver; prioritize downtime reduction and continuity of operation.';
  } else if (learningPattern === 'chronic_performance_loss') {
    recommendation =
      'Performance is the persistent systemic loss driver; prioritize throughput stability and execution-rate recovery.';
  } else if (learningPattern === 'chronic_quality_loss') {
    recommendation =
      'Quality is the persistent systemic loss driver; prioritize defect reduction and conformance stabilization.';
  }

  const confidence = Number(
    clamp01(
      0.35 +
        Math.min(history.length, 12) / 20 +
        (recentOeeSeries.length >= 5 ? 0.15 : recentOeeSeries.length / 40) +
        (baselineOeeSeries.length >= 4 ? 0.1 : 0) +
        (learningPattern !== 'insufficient_history' ? 0.1 : 0)
    ).toFixed(2)
  );

  const dominantSignals = [
    `drift=${drift.toFixed(4)}`,
    `slope=${slope.toFixed(4)}`,
    `volatility=${volatility.toFixed(4)}`,
    `dominant_loss=${dominantChronicLoss || 'none'}`,
  ];

  const supportingSignals = [
    `recent_mean_oee=${recentMeanOee.toFixed(4)}`,
    `baseline_mean_oee=${baselineMeanOee.toFixed(4)}`,
    `sign_changes=${signChanges}`,
  ];

  const riskDrivers = dominantChronicLoss
    ? [`persistent_${dominantChronicLoss}_loss`, globalDriftScore >= 0.35 ? 'system_drift' : null]
    : [globalDriftScore >= 0.35 ? 'system_drift' : null, volatility >= 0.035 ? 'oee_volatility' : null]
        .filter(Boolean);

  return {
    learningState,
    learningPattern,
    confidence,
    globalDriftScore,
    predictedSystemOEE,
    dominantChronicLoss,
    cpsContributionRanking,
    recommendation,
    derivedLearning: {
      pattern: learningPattern,
      confidence,
      drift: globalDriftScore,
      dominantChronicLoss,
    },
    systemEvidence: {
      dominantSignals,
      drift,
      slope,
      volatility,
      signChanges,
      chronicLossScores: lossScores,
    },
    learningConsensus: dominantChronicLoss ? `loss_${dominantChronicLoss}` : learningPattern,
    fleetDriftIndex: globalDriftScore,
    fleetAnomalyIndex: Number(clamp01(volatility * 10).toFixed(4)),
    stabilityIndex: Number(clamp01(1 - volatility * 8 - Math.abs(slope) * 10).toFixed(4)),
    supportingSignals,
    riskDrivers,
    historySummary: {
      samples: history.length,
      recentMeanOEE: Number(recentMeanOee.toFixed(4)),
      baselineMeanOEE: Number(baselineMeanOee.toFixed(4)),
      volatility: Number(volatility.toFixed(4)),
    },
  };
};

const parseFeatureStateTopic = (base, incoming) => {
  const baseNorm = normalizeTopic(base);
  const incNorm = normalizeTopic(incoming);

  if (!(incNorm === baseNorm || incNorm.startsWith(`${baseNorm}/`))) return null;

  const rel = incNorm.slice(baseNorm.length).replace(/^\/+/, '');
  const parts = rel.split('/');

  if (parts.length >= 3 && parts[0] === 'feat' && parts[2] === '$state') {
    return { featKey: parts[1], plant: null };
  }

  if (parts.length >= 4 && parts[1] === 'feat' && parts[3] === '$state') {
    return { featKey: parts[2], plant: parts[0] };
  }

  return null;
};

const normalizeFeatureStatusEN = (s) => {
  const v = String(s || '').toLowerCase();

  if (v === 'active') return 'active';
  if (v === 'maintenance') return 'maintenance';
  if (v === 'awaiting_replacement') return 'awaiting_replacement';
  if (v === 'failure') return 'failure';
  if (v === 'ok') return 'active';
  if (v === 'running') return 'active';

  if (v === 'ativo' || v === 'rodando') return 'active';
  if (v === 'manutencao') return 'maintenance';
  if (v === 'espera') return 'awaiting_replacement';
  if (v === 'falha') return 'failure';

  return null;
};

const mapOperationalStateToPlayStatus = (operationalState) => {
  const s = String(operationalState || '').toLowerCase();

  if (s === 'active' || s === 'running') return 'Rodando';
  if (s === 'stopped' || s === 'inactive') return 'Parado';
  if (s === 'maintenance') return 'Parado';
  return 'Parado';
};

const mapOperationalStateToGlobalState = (operationalState) => {
  const s = String(operationalState || '').toLowerCase();

  if (s === 'active' || s === 'running') return 'running';
  if (s === 'stopped' || s === 'inactive') return 'stopped';
  if (s === 'maintenance') return 'maintenance';
  if (s === 'awaiting_replacement') return 'awaiting_replacement';
  if (s === 'failure') return 'failure';
  return null;
};

const getExplicitOperationMode = (payload) =>
  payload?.OperationMode ??
  payload?.operationMode ??
  payload?.operationalMode ??
  payload?.operationalState ??
  payload?.mode ??
  null;

const getStatusOperationalState = (payload) =>
  payload?.operationalState ?? payload?.state ?? payload?.status ?? null;

const operationalDataWithMode = (cps, mode) =>
  hasIndependentPhysicalOperationMode(cps)
    ? { ...(cps?.operationalData || {}) }
    : {
        ...(cps?.operationalData || {}),
        operationMode: mode ?? cps?.operationalData?.operationMode ?? null,
      };

const canonicalOperationMode = (mode) => {
  const value = String(mode ?? '').trim().toLowerCase();
  if (value === 'active' || value === 'run' || value === 'running') return 'running';
  if (value === 'stop' || value === 'stopped' || value === 'paused' || value === 'inactive') {
    return 'stopped';
  }
  if (value === 'maintenance') return 'maintenance';
  if (value === 'unplug' || value === 'unplugged') return 'unplugged';
  if (value === 'return' || value === 'returning') return 'returning';
  return value;
};

const isRuntimeOperationMode = (mode) =>
  ['running', 'stopped', 'maintenance', 'unplugged', 'returning'].includes(
    canonicalOperationMode(mode)
  );

const normalizeOperationMode = (cps) =>
  canonicalOperationMode(
    cps?.operationalData?.operationMode ??
      cps?.operationalState ??
      cps?.operationMode ??
      cps?.operationalMode ??
      cps?.globalState?.state ??
      cps?.globalState?.status ??
      ''
  );

const getCanonicalOperationalState = (cps) =>
  canonicalOperationMode(
    cps?.operationalState ??
      cps?.globalState?.state ??
      cps?.globalState?.status ??
      cps?.status ??
      ''
  );

const mapOperationalStateToDisplayStatus = (operationalState) => {
  const state = canonicalOperationMode(operationalState);
  if (state === 'running') return 'Rodando';
  if (state === 'maintenance') return 'Maintenance';
  if (state === 'unplugged') return 'Unplugged';
  if (state === 'returning') return 'Returning';
  if (state === 'stopped') return 'Parado';
  return state || 'Parado';
};

const getCpsLifecyclePhase = (cps) =>
  String(
    cps?.lifecyclePhase ??
      cps?.lifecycle?.phase ??
      cps?.lifecycle?.currentPhase ??
      cps?.currentLifecyclePhase ??
      cps?.currentPhase ??
      ''
  )
    .trim()
    .toLowerCase();

const isCpsInPlay = (cps) => getCpsLifecyclePhase(cps) === 'play';

const isCpsOperationallyRunning = (cps) =>
  isCpsInPlay(cps) && normalizeOperationMode(cps) === 'running';

const NON_RUNNING_OPERATIONAL_STATES = new Set([
  'stopped',
  'maintenance',
  'unplugged',
  'returning',
]);

const isCpsExplicitlyNonRunning = (cps) =>
  isCpsInPlay(cps) && NON_RUNNING_OPERATIONAL_STATES.has(normalizeOperationMode(cps));

const canIngestCognitivePayload = (cps) =>
  isCpsInPlay(cps) && !isCpsExplicitlyNonRunning(cps);

const lifecycleWithPhase = (cps, phase) => ({
  ...(cps?.lifecycle || {}),
  currentPhase: phase,
  phase,
});

const getGovernanceStatus = (cps) =>
  normalizeGovernanceStatus(cps?.governanceStatus || cps?.governanceProfile?.status);

const governanceWithProfile = (cps, profile) => ({
  ...(cps || {}),
  governanceProfile: profile || cps?.governanceProfile || null,
  governanceStatus:
    profile?.status || cps?.governanceStatus || GOVERNANCE_STATUS.NOT_DEFINED,
});

const getRegistryCpsForEntry = (entry, registrySnapshot = {}) => {
  const keys = [
    entry?.cpsId,
    entry?.baseTopic,
    entry?.cpsName,
    entry?.history?.at?.(-1)?.cpsId,
    entry?.history?.at?.(-1)?.baseTopic,
    entry?.history?.at?.(-1)?.cpsName,
  ]
    .filter(Boolean)
    .map((value) => normalizeCpsId(value))
    .filter(Boolean);

  return keys
    .map((key) => registrySnapshot[key] || Object.values(registrySnapshot).find((c) => normalizeCpsId(c?.id) === key))
    .find(Boolean) || null;
};

const isKnowledgeEntryInPlay = (entry, registrySnapshot = {}) => {
  const registryCps = getRegistryCpsForEntry(entry, registrySnapshot);
  return isCpsInPlay(registryCps || entry?.history?.at?.(-1) || entry);
};

const getLatestPlaySnapshot = (entry) => {
  const history = Array.isArray(entry?.history) ? entry.history : [];
  return [...history].reverse().find((snapshot) => isCpsInPlay(snapshot)) || null;
};

const buildGlobalCpsMetrics = (store, registrySnapshot = {}) => {
  const allCpsEntries = Object.values(store?.cps || {}).filter(Boolean);

  return allCpsEntries
    .filter((entry) => isKnowledgeEntryInPlay(entry, registrySnapshot))
    .map((entry) => {
      const last = getLatestPlaySnapshot(entry);
      if (!last) return null;

      return {
        cpsId: normalizeCpsId(last?.cpsId || entry?.cpsId || entry?.baseTopic),
        cpsName: last?.cpsName || entry?.cpsName || null,
        oee: toNumber(last?.oee?.oee ?? last?.oee?.value ?? last?.oee?.current ?? last?.oee, null),
        availability: toNumber(last?.oee?.availability, null),
        performance: toNumber(last?.oee?.performance, null),
        quality: toNumber(last?.oee?.quality, null),
      };
    })
    .filter((item) => item?.cpsId);
};

const getSubmodelByIdShort = (parsed, idShort) =>
  (parsed?.submodels || []).find((sm) => sm?.idShort === idShort);

const getPropertyValueFromElements = (elements = [], idShort) => {
  const el = (elements || []).find((item) => item?.idShort === idShort);
  return el?.value ?? null;
};

const getCollectionValue = (elements = [], collectionIdShort, propertyIdShort) => {
  const col = (elements || []).find((item) => item?.idShort === collectionIdShort);
  const valueArr = Array.isArray(col?.value) ? col.value : [];
  const prop = valueArr.find((item) => item?.idShort === propertyIdShort);
  return prop?.value ?? null;
};

const getSpecificAssetIdValue = (aas, name) => {
  const arr = aas?.assetInformation?.specificAssetIds || [];
  const item = arr.find(
    (x) => String(x?.name || '').toLowerCase() === String(name || '').toLowerCase()
  );
  return item?.value ?? null;
};

const getFeatureDefinitionsFromAAS = (parsed, baseTopic) => {
  const smFunctions = getSubmodelByIdShort(parsed, 'Functions');
  const topic = normalizeTopic(baseTopic);

  if (!smFunctions?.submodelElements?.length) return [];

  const funcionalidades = [];

  for (const el of smFunctions.submodelElements || []) {
    const key = el?.idShort;
    if (!key) continue;

    const dict = Object.fromEntries(
      (el?.value || [])
        .filter((e) => e?.modelType === 'Property')
        .map((e) => [e.idShort, e.value])
    );

    funcionalidades.push({
      key,
      nome: dict.Name || key,
      descricao: dict.Description || '',
      allowed: String(dict.AllowedStatuses || '')
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean),
      statusAtual: null,
      lastUpdate: null,
      lastDetails: null,
      topics: {
        command: dict.CommandTopic || `${topic}/feat/${key}/cmd`,
        state: dict.StateTopic || `${topic}/feat/${key}/$state`,
      },
    });
  }

  return funcionalidades;
};

const parseAASCps = (parsed) => {
  const aas = Array.isArray(parsed?.assetAdministrationShells)
    ? parsed.assetAdministrationShells[0]
    : null;

  if (!aas) {
    throw new Error('AAS principal ausente em assetAdministrationShells[0].');
  }

  const smDigital = getSubmodelByIdShort(parsed, 'DigitalNameplate');
  const smTechnical = getSubmodelByIdShort(parsed, 'TechnicalData');
  const smOperational = getSubmodelByIdShort(parsed, 'OperationalData');
  const smHealth = getSubmodelByIdShort(parsed, 'StatusAndHealth');
  const smDocs = getSubmodelByIdShort(parsed, 'Documents');
  const smInterfaces = getSubmodelByIdShort(parsed, 'AssetInterfacesDescription');
  const smLifecycle = getSubmodelByIdShort(parsed, 'LifecycleIntegration');
  const smAcsm = getSubmodelByIdShort(parsed, 'ACSMIntegration');

  if (!smInterfaces) {
    throw new Error('Submodel "AssetInterfacesDescription" ausente.');
  }

  const rawId =
    getSpecificAssetIdValue(aas, 'cpsId') ||
    getPropertyValueFromElements(smDigital?.submodelElements, 'CPSId') ||
    'UNKNOWN';

  const cpsId = normalizeCpsId(rawId) || 'unknown';

  const assetName =
    getSpecificAssetIdValue(aas, 'assetName') ||
    getPropertyValueFromElements(smDigital?.submodelElements, 'ManufacturerProductDesignation') ||
    aas?.idShort ||
    cpsId;

  const displayName =
    getSpecificAssetIdValue(aas, 'displayName') ||
    (Array.isArray(aas?.displayName)
      ? aas.displayName.find((entry) => entry?.language === 'en')?.text ||
        aas.displayName.find((entry) => entry?.language === 'en-US')?.text ||
        aas.displayName[0]?.text
      : '') ||
    assetName;

  const manufacturer =
    getSpecificAssetIdValue(aas, 'manufacturer') ||
    getPropertyValueFromElements(smDigital?.submodelElements, 'ManufacturerName') ||
    '';

  const assetType =
    getSpecificAssetIdValue(aas, 'assetType') ||
    getPropertyValueFromElements(smTechnical?.submodelElements, 'AssetType') ||
    getPropertyValueFromElements(smTechnical?.submodelElements, 'ConveyorType') ||
    '';

  const realDescription =
    getSpecificAssetIdValue(aas, 'description') ||
    getPropertyValueFromElements(smTechnical?.submodelElements, 'Description') ||
    '';

  const serialNumber =
    getSpecificAssetIdValue(aas, 'serialNumber') ||
    getPropertyValueFromElements(smDigital?.submodelElements, 'SerialNumber') ||
    '';

  const baseTopic =
    getPropertyValueFromElements(smInterfaces?.submodelElements, 'BaseTopic') ||
    getSpecificAssetIdValue(aas, 'baseTopic') ||
    cpsId;

  const topic = normalizeTopic(baseTopic);

  const brokerHost =
    getPropertyValueFromElements(smInterfaces?.submodelElements, 'BrokerHost') ||
    'localhost';

  const brokerPort =
    getPropertyValueFromElements(smInterfaces?.submodelElements, 'BrokerPort') || '1883';

  const brokerWs =
    getCollectionValue(smInterfaces?.submodelElements, 'WebSocketInterfaces', 'MQTTWS') ||
    'ws://localhost:9001/mqtt';

  const brokerWss =
    getCollectionValue(smInterfaces?.submodelElements, 'WebSocketInterfaces', 'MQTTWSS') ||
    'wss://localhost:9001/mqtt';

  const descriptionEndpoint =
    getCollectionValue(smInterfaces?.submodelElements, 'RESTEndpoints', 'DescriptionEndpoint') ||
    '';

  const summaryEndpoint =
    getCollectionValue(smInterfaces?.submodelElements, 'RESTEndpoints', 'SummaryEndpoint') || '';

  const indicatorsEndpoint =
    getCollectionValue(smInterfaces?.submodelElements, 'RESTEndpoints', 'IndicatorsEndpoint') || '';

  const historyEndpoint =
    getCollectionValue(smInterfaces?.submodelElements, 'RESTEndpoints', 'HistoryEndpoint') || '';

  const healthEndpoint =
    getCollectionValue(smInterfaces?.submodelElements, 'RESTEndpoints', 'HealthEndpoint') || '';

  const dashboardUrl =
    getPropertyValueFromElements(smDocs?.submodelElements, 'DashboardURL') ||
    getPropertyValueFromElements(smAcsm?.submodelElements, 'DashboardURL') ||
    '';

  const currentPhase =
    getPropertyValueFromElements(smLifecycle?.submodelElements, 'CurrentPhase') || 'plug';

  const supportedPhases =
    getPropertyValueFromElements(smLifecycle?.submodelElements, 'SupportedPhases') || '';

  const operationMode =
    getPropertyValueFromElements(smOperational?.submodelElements, 'OperationMode') || null;

  const operationalState =
    getPropertyValueFromElements(smHealth?.submodelElements, 'OperationalState') || 'Unknown';

  const availability =
    getPropertyValueFromElements(smHealth?.submodelElements, 'Availability') || 'Unknown';

  const healthState =
    getPropertyValueFromElements(smHealth?.submodelElements, 'HealthState') || 'Unknown';

  const lastHeartbeat =
    getPropertyValueFromElements(smHealth?.submodelElements, 'LastHeartbeat') || null;

  const parsedHeartbeatTs = lastHeartbeat ? new Date(lastHeartbeat).getTime() : null;
  const initialPlayStatus = mapOperationalStateToPlayStatus(operationalState);
  const initialGlobalState = mapOperationalStateToGlobalState(operationalState);

  const apiData =
    normalizeUrl(indicatorsEndpoint) ||
    normalizeUrl(summaryEndpoint) ||
    normalizeUrl(descriptionEndpoint) ||
    normalizeUrl(getPropertyValueFromElements(smTechnical?.submodelElements, 'APIData')) ||
    '';

  const funcionalidades = getFeatureDefinitionsFromAAS(parsed, topic);
  const aasSubmodelRefs = (aas?.submodels || [])
    .flatMap((ref) => [
      ref?.value,
      ...(Array.isArray(ref?.keys) ? ref.keys.map((key) => key?.value) : []),
    ])
    .filter(Boolean);
  const aasSubmodelIdShorts = (parsed?.submodels || [])
    .map((submodel) => submodel?.idShort)
    .filter(Boolean);
  const aasElementIdShorts = [];
  const collectElementIdShorts = (elements = []) => {
    elements.forEach((element) => {
      if (element?.idShort) aasElementIdShorts.push(element.idShort);
      if (Array.isArray(element?.value)) collectElementIdShorts(element.value);
      if (Array.isArray(element?.submodelElements)) collectElementIdShorts(element.submodelElements);
    });
  };
  (parsed?.submodels || []).forEach((submodel) => collectElementIdShorts(submodel?.submodelElements));

  return {
    aas,
    cps: {
      id: cpsId,
      nome: displayName,
      assetName,
      displayName,
      descricao:
        realDescription ||
        `${sanitizeManagedText(manufacturer)}${assetType ? ` - ${sanitizeManagedText(assetType)}` : ''}${
          serialNumber ? ` - SN ${sanitizeManagedText(serialNumber)}` : ''
        }`.trim() || 'No description available.',
      manufacturer,
      assetType,
      serialNumber,
      server: brokerHost,
      brokerPort,
      brokerWs,
      brokerWss,
      topic,
      apiData,
      dashboardUrl: normalizeUrl(dashboardUrl),
      endpoints: {
        description: normalizeUrl(descriptionEndpoint),
        summary: normalizeUrl(summaryEndpoint),
        indicators: normalizeUrl(indicatorsEndpoint),
        history: normalizeUrl(historyEndpoint),
        health: normalizeUrl(healthEndpoint),
      },
      lifecycle: {
        cpsId,
        cpsName: displayName,
        baseTopic: topic,
        currentPhase,
        supportedPhases,
      },
      aasMetadata: {
        id: aas?.id || null,
        idShort: aas?.idShort || null,
        submodelRefs: aasSubmodelRefs,
        submodelIdShorts: aasSubmodelIdShorts,
        elementIdShorts: aasElementIdShorts,
      },
      maintenance: {
        inProgress: false,
        lastStartTs: null,
        lastEndTs: null,
      },
      updates: {
        lastMessage: null,
        lastType: null,
        lastTs: null,
        history: [],
      },
      operationalState: initialGlobalState || canonicalOperationMode(operationMode),
      health: {
        score: null,
        label: cpsId === 'cpslai3' ? 'NOT_COMPUTED' : healthState || null,
        ...(cpsId === 'cpslai3'
          ? { healthType: 'CPS_LAI_03_TECHNICAL_HEALTH', evidence: { evidenceStatus: 'INSUFFICIENT_EVIDENCE' } }
          : {}),
        sourceStatus: availability || operationalState || null,
        lastUpdate: Number.isFinite(parsedHeartbeatTs) ? parsedHeartbeatTs : null,
      },
      globalState: {
        state: initialGlobalState,
        status: initialGlobalState,
        playEnabled: String(currentPhase || '').toLowerCase() === 'play',
        healthScore: null,
        healthLabel: healthState || null,
        featureCount: funcionalidades.length,
        summary: `${operationalState || 'Unknown'} / ${availability || 'Unknown'}`,
        lastUpdate: Number.isFinite(parsedHeartbeatTs) ? parsedHeartbeatTs : null,
      },
      oee: {
        availability: null,
        performance: null,
        quality: null,
        value: null,
        totals: null,
        sourceStatus: null,
        lastUpdate: null,
      },
      operationalData: {
        currentTemperature: getPropertyValueFromElements(
          smOperational?.submodelElements,
          'CurrentTemperature'
        ),
        currentRPM: getPropertyValueFromElements(smOperational?.submodelElements, 'CurrentRPM'),
        currentTorque: getPropertyValueFromElements(
          smOperational?.submodelElements,
          'CurrentTorque'
        ),
        pieceCounter: getPropertyValueFromElements(smOperational?.submodelElements, 'PieceCounter'),
        cycleTimeMs: getPropertyValueFromElements(smOperational?.submodelElements, 'CycleTimeMs'),
        operationMode,
      },
      documents: {
        datasheetPdf: getPropertyValueFromElements(smDocs?.submodelElements, 'DatasheetPDF'),
        scientificReportPdf: getPropertyValueFromElements(
          smDocs?.submodelElements,
          'ScientificReportPDF'
        ),
      },
      funcionalidades,
      status: initialPlayStatus,
    },
  };
};

const buildSubscriptionTopicsForCps = (cps) => {
  if (!cps?.topic) return [];

  const [baseNo, baseWith] = topicVariants(cps.topic);

  const cmdNo = joinTopic(baseNo, COMMAND_TOPIC_SUFFIX);
  const cmdWith = joinTopic(baseWith, COMMAND_TOPIC_SUFFIX);

  const dataNo = joinTopic(baseNo, DATA_TOPIC_SUFFIX);
  const dataWith = joinTopic(baseWith, DATA_TOPIC_SUFFIX);

  const ackNo = joinTopic(baseNo, ACK_TOPIC_SUFFIX);
  const ackWith = joinTopic(baseWith, ACK_TOPIC_SUFFIX);

  const statusNo = joinTopic(baseNo, STATUS_TOPIC_SUFFIX);
  const statusWith = joinTopic(baseWith, STATUS_TOPIC_SUFFIX);

  const healthNo = joinTopic(baseNo, HEALTH_TOPIC_SUFFIX);
  const healthWith = joinTopic(baseWith, HEALTH_TOPIC_SUFFIX);

  const oeeNo = joinTopic(baseNo, OEE_TOPIC_SUFFIX);
  const oeeWith = joinTopic(baseWith, OEE_TOPIC_SUFFIX);
  const experimentalMetricsNo = joinTopic(baseNo, 'experimental-metrics');
  const experimentalMetricsWith = joinTopic(baseWith, 'experimental-metrics');

  const alarmNo = joinTopic(baseNo, ALARM_TOPIC_SUFFIX);
  const alarmWith = joinTopic(baseWith, ALARM_TOPIC_SUFFIX);

  const featWildcardNo = joinTopic(baseNo, '+/feat/+/$state');
  const featWildcardWith = joinTopic(baseWith, '+/feat/+/$state');

  const adaptiveNo = joinTopic(baseNo, 'local/adaptive');
  const adaptiveWith = joinTopic(baseWith, 'local/adaptive');

  const featStates = (cps.funcionalidades || []).flatMap((f) => {
    const state = f?.topics?.state;
    if (!state) return [];
    const [fsNo, fsWith] = topicVariants(state);
    return [fsNo, fsWith];
  });

  return [
    baseNo,
    baseWith,
    cmdNo,
    cmdWith,
    dataNo,
    dataWith,
    ackNo,
    ackWith,
    statusNo,
    statusWith,
    healthNo,
    healthWith,
    oeeNo,
    oeeWith,
    ...(normalizeCpsId(cps?.id ?? cps?.cpsId) === 'cpslai3'
      ? [experimentalMetricsNo, experimentalMetricsWith]
      : []),
    alarmNo,
    alarmWith,
    adaptiveNo,
    adaptiveWith,
    ...featStates,
    featWildcardNo,
    featWildcardWith,
  ].filter(Boolean);
};

async function loadMqttConnect() {
  const mod = await import('mqtt');
  const connect =
    mod?.connect ||
    mod?.default?.connect ||
    (typeof mod?.default === 'function' ? mod.default : undefined);
  return typeof connect === 'function' ? connect : null;
}

const emptySystemAnalytics = () => ({
  ts: null,
  cpsCount: 0,
  globalOEE: {
    availability: null,
    performance: null,
    quality: null,
    oee: null,
  },
  criticalCPS: null,
  criticalityRanking: [],
  bottleneck: null,
  cascadeEffect: false,
  synchronizationIssue: false,
  bottleneckMigrating: false,
  dominantLosses: [],
  learnedPattern: 'unknown',
  patternLearned: 'unknown',
  systemPattern: 'unknown',
  predictedGlobalOEE: null,
  predictedOeeGlobal: null,
  riskLevel: 'unknown',
  confidence: 0,
  recommendation: 'No recommendation yet.',
  explanation: 'No system-level explanation yet.',
  coordinatorOutput: null,
  systemEvidence: {},
  systemLearningModel: null,
  systemCausality: null,
  systemAnomaly: null,
  systemForecast: null,
  systemReasoning: {},
  crossCpsPatterns: [],
  riskSummary: {},
  recommendedFocus: null,
  actionPlan: {},
  systemState: {},
  coordinationMode: null,
  learningConsensus: null,
  learningState: 'insufficient_history',
  learningPattern: 'insufficient_history',
  globalDriftScore: 0,
  dominantChronicLoss: null,
  cpsContributionRanking: [],
  fleetAnomalyIndex: null,
  fleetDriftIndex: null,
  stabilityIndex: null,
  riskDrivers: [],
  supportingSignals: [],
  derivedLearning: {},
  predictedRisk: {},
  historySummary: {},
  globalSummary: {},
  reasoning: {},
  learning: {},
  synchronization: {},
  lossPropagation: {},
  bottleneckMigration: {},
  generatedAt: null,
  timestamp: null,
  criticalCps: null,
  oee: {
    oee: null,
    current: null,
    average: null,
  },
});

const emptySupplyChainCoordinator = () => ({
  input: null,
  state: null,
  reasoning: null,
  decision: null,
  alerts: {
    alerts: [],
  },
  summary: null,
});

const getSystemAnalyticsOverallOee = (analytics) => {
  const value =
    analytics?.globalSummary?.overallOee ??
    analytics?.globalOEE?.oee ??
    analytics?.oee?.oee ??
    analytics?.oee?.current ??
    analytics?.oee;

  return toNumber(value, null);
};

const getSystemAnalyticsAvailability = (analytics) =>
  toNumber(analytics?.globalSummary?.overallAvailability ?? analytics?.globalOEE?.availability, null);

const getSystemAnalyticsPerformance = (analytics) =>
  toNumber(analytics?.globalSummary?.overallPerformance ?? analytics?.globalOEE?.performance, null);

const getSystemAnalyticsQuality = (analytics) =>
  toNumber(analytics?.globalSummary?.overallQuality ?? analytics?.globalOEE?.quality, null);

const getSystemAnalyticsConfidence = (analytics) =>
  toNumber(
    analytics?.confidence ??
      analytics?.riskSummary?.confidence ??
      analytics?.predictedRisk?.confidence,
    null
  );

const getSystemAnalyticsStabilityIndex = (analytics) =>
  toNumber(analytics?.stabilityIndex, null);

const getSystemAnalyticsCriticalCpsId = (analytics) =>
  normalizeCpsId(analytics?.criticalCPS?.cpsId || analytics?.criticalCps || analytics?.criticalCPS);

const getSystemAnalyticsBottleneckCpsId = (analytics) =>
  normalizeCpsId(
    analytics?.bottleneck?.cpsId || analytics?.bottleneckCps || analytics?.bottleneck
  );

const getSystemAnalyticsMostCriticalAcsm = (analytics) =>
  analytics?.mostCriticalAcsm || analytics?.criticalCoordinationPoint?.acsmId || null;

const getSystemAnalyticsRiskLevel = (analytics) =>
  String(
    analytics?.riskLevel || analytics?.riskSummary?.level || analytics?.predictedRisk?.level || ''
  ).toLowerCase() || null;

const hasDisplayableSystemAnalytics = (analytics) => {
  if (!analytics || typeof analytics !== 'object') return false;

  return (
    Number.isFinite(getSystemAnalyticsOverallOee(analytics)) ||
    hasKeys(analytics?.globalSummary) ||
    hasKeys(analytics?.reasoning) ||
    hasKeys(analytics?.learning) ||
    hasKeys(analytics?.systemEvidence) ||
    hasKeys(analytics?.historySummary) ||
    hasItems(analytics?.criticalityRanking) ||
    hasItems(analytics?.dominantLosses) ||
    hasItems(analytics?.cpsContributionRanking) ||
    !!getSystemAnalyticsCriticalCpsId(analytics) ||
    !!getSystemAnalyticsBottleneckCpsId(analytics) ||
    !!analytics?.generatedAt ||
    !!analytics?.timestamp ||
    !!analytics?.ts
  );
};

const hasStructuralSystemAnalyticsChange = (previousStable, nextRaw) => {
  if (!hasDisplayableSystemAnalytics(nextRaw)) return false;
  if (!hasDisplayableSystemAnalytics(previousStable)) return true;

  return (
    (previousStable?.level3Mode || null) !== (nextRaw?.level3Mode || null) ||
    (previousStable?.activeParticipantsCount ?? null) !==
      (nextRaw?.activeParticipantsCount ?? null) ||
    getSystemAnalyticsMostCriticalAcsm(previousStable) !==
      getSystemAnalyticsMostCriticalAcsm(nextRaw) ||
    getSystemAnalyticsCriticalCpsId(previousStable) !==
      getSystemAnalyticsCriticalCpsId(nextRaw) ||
    getSystemAnalyticsBottleneckCpsId(previousStable) !==
      getSystemAnalyticsBottleneckCpsId(nextRaw) ||
    getSystemAnalyticsRiskLevel(previousStable) !== getSystemAnalyticsRiskLevel(nextRaw)
  );
};

const hasSmoothSystemAnalyticsChange = (previousStable, nextRaw) => {
  if (!hasDisplayableSystemAnalytics(nextRaw)) return false;
  if (!hasDisplayableSystemAnalytics(previousStable)) return true;

  const previousOee = getSystemAnalyticsOverallOee(previousStable);
  const nextOee = getSystemAnalyticsOverallOee(nextRaw);
  const oeeChanged =
    Number.isFinite(previousOee) !== Number.isFinite(nextOee) ||
    (Number.isFinite(previousOee) &&
      Number.isFinite(nextOee) &&
      Math.abs(nextOee - previousOee) >= STABLE_SYSTEM_ANALYTICS_OEE_EPSILON);

  if (oeeChanged) return true;

  const metrics = [
    [getSystemAnalyticsAvailability(previousStable), getSystemAnalyticsAvailability(nextRaw)],
    [getSystemAnalyticsPerformance(previousStable), getSystemAnalyticsPerformance(nextRaw)],
    [getSystemAnalyticsQuality(previousStable), getSystemAnalyticsQuality(nextRaw)],
  ];

  if (
    metrics.some(
      ([prevValue, nextValue]) =>
        Number.isFinite(prevValue) !== Number.isFinite(nextValue) ||
        (Number.isFinite(prevValue) &&
          Number.isFinite(nextValue) &&
          Math.abs(nextValue - prevValue) >= STABLE_SYSTEM_ANALYTICS_RATIO_EPSILON)
    )
  ) {
    return true;
  }

  const previousConfidence = getSystemAnalyticsConfidence(previousStable);
  const nextConfidence = getSystemAnalyticsConfidence(nextRaw);
  if (
    Number.isFinite(previousConfidence) !== Number.isFinite(nextConfidence) ||
    (Number.isFinite(previousConfidence) &&
      Number.isFinite(nextConfidence) &&
      Math.abs(nextConfidence - previousConfidence) >= STABLE_SYSTEM_ANALYTICS_SCORE_EPSILON)
  ) {
    return true;
  }

  const previousStabilityIndex = getSystemAnalyticsStabilityIndex(previousStable);
  const nextStabilityIndex = getSystemAnalyticsStabilityIndex(nextRaw);
  if (
    Number.isFinite(previousStabilityIndex) !== Number.isFinite(nextStabilityIndex) ||
    (Number.isFinite(previousStabilityIndex) &&
      Number.isFinite(nextStabilityIndex) &&
      Math.abs(nextStabilityIndex - previousStabilityIndex) >=
        STABLE_SYSTEM_ANALYTICS_SCORE_EPSILON)
  ) {
    return true;
  }

  return false;
};

const computeCriticalityFromSnapshot = (snap) => {
  if (!snap) return 0;

  const oee = toNumber(snap?.oee?.oee ?? snap?.oee?.value ?? snap?.oee?.current ?? snap?.oee, 0);
  const availability = toNumber(snap?.oee?.availability, 0);
  const performance = toNumber(snap?.oee?.performance, 0);
  const quality = toNumber(snap?.oee?.quality, 0);

  const cycle = toNumber(
    snap?.operationalData?.cycleTimeMs ??
      snap?.statistics?.cycleTimeMs ??
      snap?.evidence?.cycleTimeMs,
    0
  );

  const temp = toNumber(snap?.operationalData?.currentTemperature, 0);
  const rejectLike = Math.max(0, 1 - quality);

  const normalizedCycle = Math.min(cycle / 10000, 1);
  const normalizedTemp = Math.min(temp / 100, 1);

  const score =
    (1 - oee) * 0.4 +
    (1 - availability) * 0.2 +
    (1 - performance) * 0.15 +
    rejectLike * 0.1 +
    normalizedCycle * 0.1 +
    normalizedTemp * 0.05;

  return Number(score.toFixed(4));
};

const classifyGlobalPattern = (globalOee, cascadeEffect, syncIssue) => {
  if (globalOee >= 0.85 && !cascadeEffect && !syncIssue) return 'stable_high_performance';
  if (globalOee >= 0.6 && !syncIssue) return 'stable_moderate_performance';
  if (cascadeEffect) return 'propagating_loss_pattern';
  if (syncIssue) return 'desynchronization_pattern';
  if (globalOee < 0.6) return 'degraded_global_pattern';
  return 'mixed_operational_pattern';
};

const inferRiskLevel = (globalOee, predictedGlobalOee, topCritical, cascadeEffect) => {
  if (cascadeEffect || topCritical >= 0.7 || globalOee < 0.55) return 'high';
  if ((predictedGlobalOee ?? globalOee) < globalOee || topCritical >= 0.45) return 'medium';
  return 'low';
};

const getDominantLossFromMetrics = ({ availability, performance, quality } = {}) => {
  const losses = [
    { key: 'availability', value: clamp01(1 - toNumber(availability, 0)) },
    { key: 'performance', value: clamp01(1 - toNumber(performance, 0)) },
    { key: 'quality', value: clamp01(1 - toNumber(quality, 1)) },
  ].sort((a, b) => b.value - a.value);

  return losses[0]?.key || 'availability';
};

const getSystemTrend = ({ learningPattern, predictedGlobalOEE, globalOEE, historySummary } = {}) => {
  const pattern = String(learningPattern || '').toLowerCase();
  if (pattern.includes('recovering')) return 'positive';
  if (pattern.includes('unstable') || pattern.includes('oscillation')) return 'unstable';
  if (pattern.includes('degrading') || pattern.includes('degraded')) return 'negative';

  const current = toNumber(globalOEE?.oee ?? globalOEE, null);
  const predicted = toNumber(predictedGlobalOEE, null);
  if (Number.isFinite(current) && Number.isFinite(predicted)) {
    if (predicted < current - 0.01) return 'negative';
    if (predicted > current + 0.01) return 'positive';
  }

  const volatility = toNumber(historySummary?.volatility, 0);
  if (volatility >= 0.035) return 'unstable';
  return 'stable';
};

const getSystemStateFromSignals = ({ trend, riskLevel, anomalyStatus } = {}) => {
  if (trend === 'positive') return 'recovering';
  if (anomalyStatus === 'unstable' || trend === 'unstable') return 'unstable';
  if (riskLevel === 'high' || trend === 'negative') return 'degrading';
  if (riskLevel === 'medium') return 'attention';
  return 'stable';
};

const getStabilityFromSignals = ({ trend, learningPattern, anomalyStatus } = {}) => {
  const pattern = String(learningPattern || '').toLowerCase();
  if (trend === 'positive' || pattern.includes('recovering')) return 'improving';
  if (trend === 'unstable' || anomalyStatus === 'unstable' || pattern.includes('unstable')) {
    return 'unstable';
  }
  if (trend === 'negative' || pattern.includes('degrading') || pattern.includes('degraded')) {
    return 'degrading';
  }
  return 'persistent';
};

const getCpsStateFromSnapshot = (snap) => {
  const pattern = String(
    snap?.learningPattern ||
      snap?.learning?.pattern ||
      snap?.learning?.learned ||
      snap?.features?.learningPattern ||
      ''
  ).toLowerCase();
  const risk = String(snap?.riskLevel || snap?.reasoning?.riskLevel || '').toLowerCase();
  const anomalyStatus = String(snap?.anomaly?.status || '').toLowerCase();
  const oee = toNumber(snap?.oee?.oee ?? snap?.oee?.value ?? snap?.oee?.current ?? snap?.oee, null);

  if (pattern.includes('recovering')) return 'improving';
  if (pattern.includes('unstable') || anomalyStatus === 'unstable') return 'unstable';
  if (pattern.includes('degrading') || risk === 'high' || (Number.isFinite(oee) && oee < 0.55)) {
    return 'degrading';
  }
  if (risk === 'medium' || (Number.isFinite(oee) && oee < 0.75)) return 'attention';
  return 'stable';
};

const getExpectedOee = ({ globalOEE, predictedGlobalOEE, trend } = {}) => {
  const current = toNumber(globalOEE?.oee ?? globalOEE, 0);
  const predicted = toNumber(predictedGlobalOEE, null);
  const fallback =
    trend === 'negative'
      ? current - 0.04
      : trend === 'positive'
        ? current + 0.03
        : trend === 'unstable'
          ? current - 0.02
          : current;
  return Number(clamp01(Number.isFinite(predicted) ? predicted : fallback).toFixed(4));
};

const buildSystemEvidenceList = ({
  globalOEE,
  latest,
  criticalCPS,
  dominantLoss,
  trend,
  learningPattern,
  systemLearning,
  anomalyScore,
}) => {
  const evidence = [];
  const currentOee = toNumber(globalOEE?.oee, 0);
  const availability = toNumber(globalOEE?.availability, 0);
  const performance = toNumber(globalOEE?.performance, 0);
  const quality = toNumber(globalOEE?.quality, 1);
  const degradedCps = (latest || []).filter((snap) => {
    const oee = toNumber(snap?.oee?.oee ?? snap?.oee?.value ?? snap?.oee?.current ?? snap?.oee, 1);
    const risk = String(snap?.riskLevel || snap?.reasoning?.riskLevel || '').toLowerCase();
    const pattern = String(snap?.learningPattern || snap?.learning?.pattern || '').toLowerCase();
    return oee < 0.75 || risk === 'high' || pattern.includes('degrad') || pattern.includes('chronic');
  });

  if (currentOee < 0.75) evidence.push(`global OEE remained below 75% in the last ${SYSTEM_LEARNING_WINDOW_SIZE} windows`);
  if (availability < 0.65) evidence.push(`global availability remained below 65% in the last ${SYSTEM_LEARNING_WINDOW_SIZE} windows`);
  if (performance < 0.75) evidence.push('global performance is below the expected operating band');
  if (quality < 0.95) evidence.push('global quality is below the expected conformance band');
  if (degradedCps.length >= 2) evidence.push('multiple CPS showed simultaneous degradation');
  if (criticalCPS?.cpsId) evidence.push(`${criticalCPS.cpsId} contributed most to the system loss`);
  if (trend === 'negative') evidence.push('global OEE trend is negative across recent windows');
  if (trend === 'unstable' || anomalyScore >= 0.65) evidence.push('system variability increased across recent windows');
  if (String(learningPattern || '').includes('chronic')) {
    evidence.push(`global learning converged to persistent ${dominantLoss} loss`);
  }
  if (systemLearning?.riskDrivers?.length) {
    evidence.push(`learning risk drivers include ${systemLearning.riskDrivers.slice(0, 2).join(' and ')}`);
  }

  return [...new Set(evidence)].slice(0, 8);
};

const buildSystemIntelligence = ({
  latest,
  globalOEE,
  criticalityRanking,
  criticalCPS,
  dominantLosses,
  learnedPattern,
  riskLevel,
  confidence,
  systemLearning,
  cascadeEffect,
  synchronizationIssue,
  predictedGlobalOEE,
}) => {
  const dominantLoss =
    systemLearning?.dominantChronicLoss ||
    dominantLosses?.[0]?.dominantDimension ||
    getDominantLossFromMetrics(globalOEE);
  const learningPattern = systemLearning?.learningPattern || learnedPattern || 'unknown';
  const trend = getSystemTrend({
    learningPattern,
    predictedGlobalOEE: systemLearning?.predictedSystemOEE ?? predictedGlobalOEE,
    globalOEE,
    historySummary: systemLearning?.historySummary,
  });
  const degradedByAvailability = (latest || []).filter(
    (snap) => toNumber(snap?.oee?.availability, 1) < 0.7
  );
  const degradedByPerformance = (latest || []).filter(
    (snap) => toNumber(snap?.oee?.performance, 1) < 0.75
  );
  const highAnomalyCps = (latest || []).filter((snap) => toNumber(snap?.anomaly?.score, 0) >= 0.55);
  const enrichedRanking = (criticalityRanking || [])
    .map((entry) => {
      const snap = (latest || []).find(
        (item) => normalizeCpsId(item?.cpsId || item?.baseTopic) === normalizeCpsId(entry?.cpsId)
      );
      const dominantLossForCps = getDominantLossFromMetrics({
        availability: snap?.oee?.availability,
        performance: snap?.oee?.performance,
        quality: snap?.oee?.quality,
      });
      const localConfidence = toNumber(
        snap?.confidence ?? snap?.reasoning?.confidence ?? snap?.learning?.confidence,
        0.5
      );
      const anomalyBoost = toNumber(snap?.anomaly?.score, 0) * 0.15;
      const riskBoost =
        String(snap?.riskLevel || snap?.reasoning?.riskLevel || '').toLowerCase() === 'high'
          ? 0.08
          : 0;
      const impactScore = clamp01(toNumber(entry?.score, 0) * 0.78 + localConfidence * 0.14 + anomalyBoost + riskBoost);

      return {
        cpsId: entry.cpsId,
        cpsName: entry.cpsName || snap?.cpsName || '',
        baseTopic: entry.baseTopic || snap?.baseTopic || entry.cpsId,
        score: entry.score,
        impactScore: Number(impactScore.toFixed(4)),
        dominantLoss: dominantLossForCps,
        state: getCpsStateFromSnapshot(snap),
      };
    })
    .sort((a, b) => b.impactScore - a.impactScore);
  const relatedCps = enrichedRanking
    .filter((entry) => entry.impactScore >= 0.35 || entry.cpsId === criticalCPS?.cpsId)
    .slice(0, 3)
    .map((entry) => entry.cpsId);
  const affectedCps = relatedCps.length ? relatedCps : enrichedRanking.slice(0, 2).map((entry) => entry.cpsId);

  let probableCause = `${dominantLoss} loss`;
  let causeType = `${dominantLoss}_loss`;
  if (degradedByAvailability.length >= 2) {
    probableCause = 'distributed availability loss';
    causeType = 'multi_cps_degradation';
  } else if (enrichedRanking[0]?.impactScore >= 0.65) {
    probableCause = 'single critical bottleneck';
    causeType = 'single_critical_bottleneck';
  } else if (degradedByPerformance.length >= 2 || dominantLoss === 'performance') {
    probableCause = 'execution slowdown';
    causeType = 'execution_slowdown';
  } else if (synchronizationIssue || highAnomalyCps.length >= 2) {
    probableCause = 'system instability';
    causeType = 'system_instability';
  } else if (cascadeEffect || String(learningPattern).includes('degrad')) {
    probableCause = 'propagating degradation risk';
    causeType = 'propagating_degradation_risk';
  }

  const affectedDimensions = [
    dominantLoss,
    toNumber(globalOEE?.oee, 0) < 0.75 ? 'global_oee' : null,
    toNumber(globalOEE?.availability, 1) < 0.7 ? 'availability' : null,
    toNumber(globalOEE?.performance, 1) < 0.75 ? 'throughput' : null,
    toNumber(globalOEE?.quality, 1) < 0.95 ? 'quality' : null,
  ].filter(Boolean);
  const anomalyScore = Number(
    clamp01(
      Math.max(
        systemLearning?.fleetAnomalyIndex || 0,
        1 - toNumber(globalOEE?.oee, 0),
        enrichedRanking[0]?.impactScore || 0
      )
    ).toFixed(4)
  );
  let anomalyStatus = 'normal';
  if (trend === 'unstable' || synchronizationIssue) anomalyStatus = 'unstable';
  else if (riskLevel === 'high' || toNumber(globalOEE?.oee, 0) < 0.55) anomalyStatus = 'degraded';
  else if (affectedDimensions.length >= 2 || riskLevel === 'medium') anomalyStatus = 'below_normal';
  else if (toNumber(globalOEE?.oee, 0) >= 0.85) anomalyStatus = 'above_normal';

  const systemEvidence = buildSystemEvidenceList({
    globalOEE,
    latest,
    criticalCPS,
    dominantLoss,
    trend,
    learningPattern,
    systemLearning,
    anomalyScore,
  });
  const stability = getStabilityFromSignals({ trend, learningPattern, anomalyStatus });
  const systemState = getSystemStateFromSignals({ trend, riskLevel, anomalyStatus });
  const expectedOEE = getExpectedOee({
    globalOEE,
    predictedGlobalOEE: systemLearning?.predictedSystemOEE ?? predictedGlobalOEE,
    trend,
  });
  const forecastRisk =
    riskLevel === 'high' || anomalyStatus === 'degraded' || expectedOEE < 0.55
      ? 'high'
      : riskLevel === 'medium' || anomalyStatus === 'unstable' || expectedOEE < 0.7
        ? 'medium'
        : 'low';
  const nextState =
    forecastRisk === 'high' && affectedCps.length >= 2
      ? 'coordination_required'
      : String(learningPattern).includes('chronic') && affectedCps.length >= 2
        ? 'maintenance_wave_risk'
        : trend === 'positive'
          ? 'stabilizing'
          : trend === 'unstable'
            ? 'unstable'
            : trend === 'negative'
              ? 'distributed_degradation'
              : 'stabilizing';
  const causalConfidence = Number(
    clamp01(Math.max(toNumber(confidence, 0.5) - 0.02, systemEvidence.length >= 3 ? 0.72 : 0.6)).toFixed(2)
  );

  const systemLearningModel = {
    model: 'multi_cps_system_learning_v1',
    pattern: learningPattern,
    windowSize: SYSTEM_LEARNING_WINDOW_SIZE,
    dominantLoss,
    criticalCps: affectedCps.length ? affectedCps : criticalCPS?.cpsId ? [criticalCPS.cpsId] : [],
    stability,
    confidence: toNumber(confidence, systemLearning?.confidence ?? 0),
    description: `${stability} system pattern driven by ${dominantLoss} loss across critical CPS`,
  };
  const systemCausality = {
    probableCause,
    causeType,
    primaryDriver: enrichedRanking[0]?.cpsId || criticalCPS?.cpsId || null,
    relatedCps: affectedCps,
    causalConfidence,
  };
  const systemAnomaly = {
    score: anomalyScore,
    status: anomalyStatus,
    affectedDimensions: [...new Set(affectedDimensions)],
    affectedCps,
  };
  const systemForecast = {
    nextState,
    timeHorizon: 'short_term',
    risk: forecastRisk,
    confidence: toNumber(confidence, systemLearning?.confidence ?? 0),
    expectedOEE,
  };
  const systemReasoning = {
    systemState,
    dominantLoss,
    primaryIssue:
      causeType === 'multi_cps_degradation'
        ? `distributed ${dominantLoss} loss across critical CPS`
        : `${probableCause} led by ${systemCausality.primaryDriver || 'managed CPS'}`,
    probableCause:
      systemCausality.primaryDriver && causeType !== 'single_critical_bottleneck'
        ? `${causeType.replace(/_/g, ' ')} led by ${systemCausality.primaryDriver}`
        : probableCause,
    trend,
    confidence: toNumber(confidence, systemLearning?.confidence ?? 0),
    executiveInterpretation:
      systemState === 'stable'
        ? 'system operation remains stable with no dominant multi-CPS degradation'
        : `system ${systemState} behavior is driven by ${dominantLoss} losses concentrated in critical CPS`,
    recommendation:
      affectedCps.length >= 2
        ? `prioritize stabilization of ${affectedCps.join(' and ')} before broader optimization actions`
        : systemCausality.primaryDriver
          ? `prioritize stabilization of ${systemCausality.primaryDriver} before broader optimization actions`
          : 'maintain system monitoring and continue coordinated supervision',
  };

  return {
    systemLearningModel,
    systemEvidence,
    systemCausality,
    criticalityRanking: enrichedRanking,
    systemAnomaly,
    systemForecast,
    systemReasoning,
    trend,
  };
};

const buildLevel2IntelligencePackage = (analytics = {}, acsmConfig = ACTIVE_ACSM) => {
  const timestamp = new Date().toISOString();
  const globalOEEValue = toNumber(
    analytics?.globalOEE?.oee ??
      analytics?.globalOEE?.current ??
      analytics?.coordinatorOutput?.globalOEE ??
      analytics?.oee?.oee,
    0
  );
  const critical = analytics?.criticalCPS && typeof analytics.criticalCPS === 'object'
    ? analytics.criticalCPS
    : analytics?.criticalCps
      ? { cpsId: analytics.criticalCps }
      : analytics?.bottleneck || {};
  const systemReasoning = analytics?.systemReasoning || analytics?.reasoning || {};
  const systemEvidence = Array.isArray(analytics?.systemEvidenceList)
    ? analytics.systemEvidenceList
    : Array.isArray(analytics?.systemEvidence)
      ? analytics.systemEvidence
      : Array.isArray(analytics?.systemEvidence?.narrative)
        ? analytics.systemEvidence.narrative
        : [];
  const participants = Array.isArray(acsmConfig?.managedCpsIds)
    ? acsmConfig.managedCpsIds
    : [];

  return {
    schemaVersion: '1.0',
    messageType: 'acsm_level2_intelligence',
    source: acsmConfig?.id || ACTIVE_ACSM.id,
    ts: Date.now(),
    timestamp,
    globalOEE: globalOEEValue,
    trend: analytics?.trend || systemReasoning?.trend || analytics?.historySummary?.trend || 'stable',
    confidence: toNumber(
      analytics?.confidence ?? analytics?.coordinatorOutput?.confidence ?? systemReasoning?.confidence,
      0
    ),
    riskLevel: analytics?.riskLevel || analytics?.coordinatorOutput?.predictedRisk || 'low',
    criticalCPS: {
      cpsId: critical?.cpsId || '',
      cpsName: critical?.cpsName || '',
    },
    learningPattern:
      analytics?.learningPattern ||
      analytics?.learnedPattern ||
      analytics?.patternLearned ||
      analytics?.systemPattern ||
      '',
    learningConsensus: analytics?.learningConsensus || analytics?.derivedLearning?.learningConsensus || '',
    recommendation:
      analytics?.recommendation ||
      analytics?.coordinatorOutput?.recommendation ||
      systemReasoning?.recommendation ||
      '',
    executiveSummary:
      analytics?.executiveSummary ||
      analytics?.explanation ||
      analytics?.coordinatorOutput?.explanation ||
      systemReasoning?.executiveInterpretation ||
      '',
    systemLearningModel: analytics?.systemLearningModel || {},
    systemEvidence,
    systemCausality: analytics?.systemCausality || {},
    criticalityRanking: Array.isArray(analytics?.criticalityRanking)
      ? analytics.criticalityRanking
      : [],
    systemAnomaly: analytics?.systemAnomaly || {},
    systemForecast: analytics?.systemForecast || {},
    systemReasoning: systemReasoning || {},
    participants,
    managedCpsCount: participants.length,
    publisher: {
      acsmId: acsmConfig?.id || ACTIVE_ACSM.id,
      level: 'level2',
    },
  };
};

const riskScore = (riskLevel) => {
  const risk = String(riskLevel || '').toLowerCase();
  if (risk === 'critical' || risk === 'high') return 1;
  if (risk === 'medium' || risk === 'moderate' || risk === 'unstable') return 0.65;
  if (risk === 'low' || risk === 'stable' || risk === 'normal') return 0.25;
  return 0.4;
};

const scoreToRisk = (score) => {
  const value = toNumber(score, 0);
  if (value >= 0.75) return 'high';
  if (value >= 0.45) return 'medium';
  return 'low';
};

const dominantValue = (values, fallback = 'unknown') => {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => {
    const key = String(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
};

const getPresentMultiAcsmInputs = (inputs = {}) =>
  ['acsm1', 'acsm2', 'acsm3']
    .map((acsmId) => inputs?.[acsmId])
    .filter(Boolean)
    .map((input) => normalizeLevel2AcsmIntelligence(input, `${input.source}/level2/intelligence`));

const buildLevel3MetaKnowledgePackage = ({
  multiAcsmInputs = emptyMultiAcsmInputs(),
  fallbackAcsm1Input = null,
} = {}) => {
  const mergedInputs = {
    ...emptyMultiAcsmInputs(),
    ...(multiAcsmInputs || {}),
  };
  if (!mergedInputs.acsm1 && fallbackAcsm1Input) {
    mergedInputs.acsm1 = fallbackAcsm1Input;
  }

  const inputs = getPresentMultiAcsmInputs(mergedInputs);
  const participants = inputs.map((input) => input.source);
  const timestamp = new Date().toISOString();
  const globalOEE = Number(mean(inputs.map((input) => toNumber(input.globalOEE, 0))).toFixed(4));
  const globalRiskScore = mean(inputs.map((input) => riskScore(input.riskLevel)));
  const riskLevel = scoreToRisk(globalRiskScore);
  const confidence = Number(mean(inputs.map((input) => toNumber(input.confidence, 0))).toFixed(2));
  const trend = dominantValue(inputs.map((input) => input.trend), 'stable');
  const dominantLoss = dominantValue(
    inputs.map(
      (input) =>
        input.systemLearningModel?.dominantLoss ||
        input.systemReasoning?.dominantLoss ||
        input.criticalityRanking?.[0]?.dominantLoss
    ),
    'oee'
  );

  const acsmCriticalityRanking = inputs
    .map((input) => {
      const rankingScore = mean(
        (input.criticalityRanking || []).map((item) => toNumber(item.impactScore ?? item.score, 0))
      );
      const anomalyScore = toNumber(input.systemAnomaly?.score, 0);
      const impactScore = Number(
        clamp01(
          mean([
            1 - toNumber(input.globalOEE, 0),
            riskScore(input.riskLevel),
            toNumber(input.confidence, 0),
            rankingScore,
            anomalyScore,
          ])
        ).toFixed(2)
      );

      return {
        acsmId: input.source,
        globalOEE: input.globalOEE,
        riskLevel: input.riskLevel,
        confidence: input.confidence,
        criticalCPS: input.criticalCPS,
        dominantLoss:
          input.systemLearningModel?.dominantLoss ||
          input.systemReasoning?.dominantLoss ||
          input.criticalityRanking?.[0]?.dominantLoss ||
          'unknown',
        impactScore,
        state:
          input.systemReasoning?.systemState ||
          input.systemForecast?.nextState ||
          input.systemLearningModel?.stability ||
          'unknown',
      };
    })
    .sort((a, b) => b.impactScore - a.impactScore);

  const globalCriticalityRanking = inputs
    .flatMap((input) =>
      (input.criticalityRanking || []).map((item) => ({
        ...item,
        acsmId: input.source,
        impactScore: toNumber(item.impactScore ?? item.score, 0),
      }))
    )
    .sort((a, b) => toNumber(b.impactScore, 0) - toNumber(a.impactScore, 0));

  const criticalLeader = globalCriticalityRanking[0];
  const acsmLeader = acsmCriticalityRanking[0];
  const criticalCPS = {
    cpsId: criticalLeader?.cpsId || acsmLeader?.criticalCPS?.cpsId || '',
    cpsName: criticalLeader?.cpsName || acsmLeader?.criticalCPS?.cpsName || '',
    acsmId: criticalLeader?.acsmId || acsmLeader?.acsmId || '',
  };
  const criticalAcsms = acsmCriticalityRanking
    .filter((item) => item.impactScore >= 0.55 || ['high', 'critical'].includes(String(item.riskLevel).toLowerCase()))
    .map((item) => item.acsmId);
  const globalSystemEvidence = inputs
    .flatMap((input) =>
      (input.systemEvidence || []).slice(0, 4).map((evidence) => `${input.source}: ${evidence}`)
    )
    .slice(0, 12);
  if (acsmLeader) {
    globalSystemEvidence.unshift(
      `${acsmLeader.acsmId} has the highest ACSM impact score (${acsmLeader.impactScore})`
    );
  }
  if (criticalCPS.cpsId) {
    globalSystemEvidence.unshift(
      `${criticalCPS.cpsId} is the highest ranked CPS across ACSM domains`
    );
  }

  const instabilityCount = inputs.filter((input) =>
    ['high', 'critical'].includes(String(input.riskLevel).toLowerCase()) ||
    ['degraded', 'unstable'].includes(String(input.systemAnomaly?.status).toLowerCase())
  ).length;
  const causeType =
    criticalAcsms.length >= 2
      ? 'multi_acsm_degradation'
      : globalCriticalityRanking.length >= 2 && new Set(globalCriticalityRanking.slice(0, 3).map((item) => item.acsmId)).size >= 2
        ? 'cross_domain_bottleneck'
        : acsmLeader
          ? 'single_domain_bottleneck'
          : 'insufficient_multi_acsm_evidence';
  const globalSystemCausality = {
    probableCause:
      causeType === 'multi_acsm_degradation'
        ? `multi-ACSM ${dominantLoss} degradation`
        : causeType === 'cross_domain_bottleneck'
          ? 'cross-domain bottleneck propagation'
          : acsmLeader
            ? `single domain bottleneck led by ${acsmLeader.acsmId}`
            : 'insufficient Level 2 evidence',
    causeType,
    primaryDriver: acsmLeader?.acsmId || null,
    relatedAcsms: criticalAcsms.length ? criticalAcsms : participants,
    relatedCps: globalCriticalityRanking.slice(0, 5).map((item) => item.cpsId).filter(Boolean),
    causalConfidence: Number(clamp01(confidence * 0.9 + Math.min(globalSystemEvidence.length, 6) * 0.02).toFixed(2)),
  };

  const anomalyScores = inputs.map((input) => toNumber(input.systemAnomaly?.score, 0));
  const globalAnomalyScore = Number(clamp01(mean(anomalyScores)).toFixed(2));
  const globalSystemAnomaly = {
    score: globalAnomalyScore,
    status:
      instabilityCount >= 2 || globalAnomalyScore >= 0.7
        ? 'degraded'
        : instabilityCount === 1 || globalAnomalyScore >= 0.45
          ? 'unstable'
          : 'normal',
    affectedDimensions: [
      ...new Set(inputs.flatMap((input) => input.systemAnomaly?.affectedDimensions || [])),
    ],
    affectedAcsms: inputs
      .filter((input) => toNumber(input.systemAnomaly?.score, 0) >= 0.45 || riskScore(input.riskLevel) >= 0.65)
      .map((input) => input.source),
    affectedCps: [
      ...new Set(inputs.flatMap((input) => input.systemAnomaly?.affectedCps || [])),
    ],
  };

  const expectedOEE = Number(
    clamp01(
      mean(inputs.map((input) => toNumber(input.systemForecast?.expectedOEE, input.globalOEE)))
    ).toFixed(4)
  );
  const forecastRisk = scoreToRisk(
    mean(inputs.map((input) => riskScore(input.systemForecast?.risk || input.riskLevel)))
  );
  const globalSystemForecast = {
    nextState:
      forecastRisk === 'high' && criticalAcsms.length >= 2
        ? 'coordination_required'
        : forecastRisk === 'high'
          ? 'propagating_degradation_risk'
          : forecastRisk === 'medium'
            ? 'unstable'
            : 'stabilizing',
    timeHorizon: 'short_term',
    risk: forecastRisk,
    confidence,
    expectedOEE,
  };

  const globalSystemState =
    riskLevel === 'high' || globalSystemAnomaly.status === 'degraded'
      ? 'degrading'
      : riskLevel === 'medium' || globalSystemAnomaly.status === 'unstable'
        ? 'unstable'
        : 'stable';
  const globalExecutiveReasoning = {
    primaryIssue:
      criticalAcsms.length >= 2
        ? `multi-ACSM ${dominantLoss} degradation across ${criticalAcsms.join(', ')}`
        : acsmLeader
          ? `${dominantLoss} loss concentrated in ${acsmLeader.acsmId}`
          : 'insufficient multi-ACSM Level 2 inputs',
    systemState: globalSystemState,
    dominantLoss,
    probableCause: globalSystemCausality.probableCause,
    trend,
    confidence,
    executiveInterpretation:
      globalSystemState === 'stable'
        ? 'multi-ACSM operation remains stable with no dominant cross-domain degradation'
        : `Level 3 meta-learning indicates ${globalSystemState} behavior driven by ${dominantLoss} losses across ACSM domains`,
    recommendation:
      globalSystemForecast.risk === 'high'
        ? `coordinate stabilization across ${globalSystemCausality.relatedAcsms.join(', ')} before supply-chain optimization`
        : acsmLeader
          ? `prioritize supervision of ${acsmLeader.acsmId} while monitoring remaining ACSM domains`
          : 'maintain multi-ACSM monitoring until enough Level 2 evidence is available',
  };

  const level3LearningModel = {
    model: 'multi_acsm_meta_learning_v1',
    pattern:
      criticalAcsms.length >= 2
        ? 'multi_acsm_distributed_degradation'
        : acsmLeader
          ? 'single_acsm_dominant_bottleneck'
          : 'insufficient_multi_acsm_history',
    dominantDomain: acsmLeader?.acsmId || null,
    dominantLoss,
    criticalAcsms,
    stability:
      globalSystemState === 'stable'
        ? 'stable'
        : globalSystemState === 'unstable'
          ? 'unstable'
          : 'degrading',
    confidence,
    description:
      participants.length >= 3
        ? `meta-learning across ${participants.length} ACSMs indicates ${globalSystemState} global behavior`
        : `partial meta-learning using ${participants.length} ACSM Level 2 input(s)`,
  };

  const recommendation = globalExecutiveReasoning.recommendation;
  const executiveSummary = globalExecutiveReasoning.executiveInterpretation;

  return {
    schemaVersion: '1.0',
    messageType: 'level3_knowledge_package',
    source: 'acsm1_service',
    target: 'supply_chain_coordinator',
    ts: Date.now(),
    timestamp,
    participants,
    multiAcsmInputs: mergedInputs,
    level3LearningModel,
    globalSystemEvidence,
    globalSystemCausality,
    globalCriticalityRanking,
    acsmCriticalityRanking,
    globalSystemAnomaly,
    globalSystemForecast,
    globalExecutiveReasoning,
    globalOEE,
    trend,
    confidence,
    riskLevel,
    criticalCPS,
    learningPattern: level3LearningModel.pattern,
    learningConsensus: level3LearningModel.pattern,
    dominantLosses: globalCriticalityRanking.slice(0, 10).map((item) => ({
      cpsId: item.cpsId || '',
      cpsName: item.cpsName || '',
      acsmId: item.acsmId || '',
      dominantLoss: item.dominantLoss || 'unknown',
      impactScore: toNumber(item.impactScore ?? item.score, 0),
    })),
    recommendation,
    executiveSummary,
    reasoning: globalExecutiveReasoning,
    systemLearningModel: level3LearningModel,
    systemEvidence: globalSystemEvidence,
    systemCausality: globalSystemCausality,
    criticalityRanking: globalCriticalityRanking,
    systemAnomaly: globalSystemAnomaly,
    systemForecast: globalSystemForecast,
    systemReasoning: globalExecutiveReasoning,
    managedCpsCount: inputs.reduce((sum, input) => sum + toNumber(input.managedCpsCount, 0), 0),
    publisher: {
      acsmId: 'acsm1',
      level: 'level3',
    },
  };
};

export const CPSProvider = ({ children, acsmId, config }) => {
  const acsmConfig = useMemo(
    () => ({ ...getActiveAcsmConfig(acsmId), ...(config || {}) }),
    [acsmId, config]
  );

  const [registry, setRegistry] = useState({});
  const [addedCPS, setAddedCPS] = useState([]);
  const [log, setLog] = useState([]);
  const [mqttClient, setMqttClient] = useState(null);
  const [mqttConnectionEpoch, setMqttConnectionEpoch] = useState(0);
  const mqttClientRef = useRef(null);
  const lifecyclePublicationRef = useRef({ client: null, phase: null });
  const cpsLai1CanonicalLifecycleRef = useRef(null);
  const publishCpsLai1LifecyclePhase = useCallback(
    (cps, lifecyclePhase) => {
      if (!isPhysicalCps(cps)) return false;

      const payload = buildCpsLai1LifecyclePayload(lifecyclePhase);
      if (!payload) return false;
      if (!canTransitionCpsLai1Lifecycle(
        cpsLai1CanonicalLifecycleRef.current,
        payload.lifecyclePhase
      )) return false;

      cpsLai1CanonicalLifecycleRef.current = payload.lifecyclePhase;
      if (!mqttClient?.connected) return false;

      const previous = lifecyclePublicationRef.current;
      const previousPhase = previous.client === mqttClient ? previous.phase : null;
      if (!shouldPublishCpsLai1Lifecycle(previousPhase, lifecyclePhase)) return false;

      try {
        mqttClient.publish(CPSLAI1_LIFECYCLE_TOPIC, JSON.stringify(payload), {
          qos: 1,
          retain: true,
        });
        lifecyclePublicationRef.current = {
          client: mqttClient,
          phase: payload.lifecyclePhase,
        };
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message:
              `[LIFECYCLE_PUBLISH] cpslai1 -> ${payload.lifecyclePhase} ` +
              `on ${CPSLAI1_LIFECYCLE_TOPIC}`,
          },
        ]);
        return true;
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[LIFECYCLE_PUBLISH_ERROR] ${error?.message || error}`,
          },
        ]);
        return false;
      }
    },
    [mqttClient]
  );
  const publishCpsLai1LifecyclePhaseRef = useRef(publishCpsLai1LifecyclePhase);
  useEffect(() => {
    publishCpsLai1LifecyclePhaseRef.current = publishCpsLai1LifecyclePhase;
  }, [publishCpsLai1LifecyclePhase]);
  const lastLevel2IntelligencePublishRef = useRef('');
  const [mqttData, setMqttData] = useState({});
  const [telemetryData, setTelemetryData] = useState({});
  const telemetryDataRef = useRef({});
  const [telemetryCommunication, setTelemetryCommunication] = useState({});
  const telemetryCommunicationTimersRef = useRef({});
  const telemetryCommunicationReceivedAtRef = useRef({});
  const cpsLai3StatusCommunicationRef = useRef(null);
  const [alerts, setAlerts] = useState([]);
  const [cpsAnalytics, setCpsAnalyticsState] = useState({});
  const [ingestionBuffer, setIngestionBuffer] = useState([]);
  const [systemAnalytics, setSystemAnalytics] = useState(emptySystemAnalytics());
  const [stableSystemAnalytics, setStableSystemAnalytics] = useState(emptySystemAnalytics());
  const [multiAcsmInputs, setMultiAcsmInputs] = useState(emptyMultiAcsmInputs());
  const [coordinatorSnapshots, setCoordinatorSnapshots] = useState(emptyCoordinatorSnapshots());
  const coordinatorSnapshotsRef = useRef(emptyCoordinatorSnapshots());
  useEffect(() => () => {
    Object.values(telemetryCommunicationTimersRef.current).forEach((timer) => clearTimeout(timer));
    telemetryCommunicationTimersRef.current = {};
  }, []);
  const [level3RuntimeStatus, setLevel3RuntimeStatus] = useState({
    level3Mode: 'partial',
    activeParticipantsCount: 0,
    expectedParticipantsCount: 3,
    managedCpsCount: 0,
    managedCpsIds: [],
    presentAcsms: [],
    missingAcsms: [],
  });
  const [supplyChainCoordinator, setSupplyChainCoordinator] = useState(
    emptySupplyChainCoordinator()
  );
  const [supplyChainPackage, setSupplyChainPackage] = useState(null);
  const [supplyChainFeedback, setSupplyChainFeedback] = useState(emptySupplyChainFeedback());
  const [localAdaptiveIntelligence, setLocalAdaptiveIntelligence] = useState(
    emptyLocalAdaptiveIntelligence()
  );
  const [serviceAdaptiveIntelligence, setServiceAdaptiveIntelligence] = useState(
    emptyServiceAdaptiveIntelligence()
  );
  const [cpsAdaptiveIntelligence, setCpsAdaptiveIntelligence] = useState({});
  const [governanceProfiles, setGovernanceProfiles] = useState({});
  const [pendingGovernanceActions, setPendingGovernanceActions] = useState([]);
  const [level3LastPublishAt, setLevel3LastPublishAt] = useState(null);
  const [level3AutoPublishEnabled, setLevel3AutoPublishEnabled] = useState(false);

  useEffect(() => {
    mqttClientRef.current = mqttClient;
  }, [mqttClient]);

  const governanceProfilesRef = useRef({});
  const lastPersistedKnowledgeSignatureRef = useRef({});
  const inFlightKnowledgeSignatureRef = useRef({});
  useEffect(() => {
    governanceProfilesRef.current = governanceProfiles;
  }, [governanceProfiles]);

  useEffect(() => {
    const analytics = stableSystemAnalytics || systemAnalytics;
    if (!hasDisplayableSystemAnalytics(analytics)) return;

    const payload = buildLevel2IntelligencePackage(analytics, ACTIVE_ACSM);
    const serializedForDedupe = JSON.stringify({
      ...payload,
      ts: 0,
      timestamp: '',
    });
    if (lastLevel2IntelligencePublishRef.current === serializedForDedupe) return;

    const client = mqttClientRef.current;
    if (!client || client.connected === false) {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[LEVEL2_INTELLIGENCE_WARN] MQTT client not connected; ${LEVEL2_INTELLIGENCE_TOPIC} not published`,
        },
      ]);
      return;
    }

    client.publish(LEVEL2_INTELLIGENCE_TOPIC, JSON.stringify(payload), {
      qos: 0,
      retain: false,
    });
    lastLevel2IntelligencePublishRef.current = serializedForDedupe;

    setLog((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        message: `[LEVEL2_INTELLIGENCE_PUBLISH] Sent to ${LEVEL2_INTELLIGENCE_TOPIC}`,
      },
    ]);
  }, [mqttClient, stableSystemAnalytics, systemAnalytics]);

  const knowledgeStoreRef = useRef({
    cps: {},
    system: {
      snapshots: [],
      learningHistory: [],
      events: [],
    },
    supplychain: emptySupplyChainCoordinator(),
    multiAcsmInputs: emptyMultiAcsmInputs(),
  });

  const addedCPSRef = useRef([]);
  useEffect(() => {
    addedCPSRef.current = addedCPS;
  }, [addedCPS]);

  const playPhaseCPS = useMemo(() => addedCPS.filter(isCpsInPlay), [addedCPS]);
  const playPhaseCPSRef = useRef([]);
  useEffect(() => {
    playPhaseCPSRef.current = playPhaseCPS;
  }, [playPhaseCPS]);

  const registryRef = useRef({});
  useEffect(() => {
    registryRef.current = registry;
  }, [registry]);

  const operationModeByCpsRef = useRef({});
  const rememberOperationMode = useCallback((cps, mode) => {
    if (!cps?.id || mode === undefined || mode === null) return;
    if (hasIndependentPhysicalOperationMode(cps)) return;
    operationModeByCpsRef.current = {
      ...operationModeByCpsRef.current,
      [cps.id]: canonicalOperationMode(mode),
    };
  }, []);
  const withRememberedOperationMode = useCallback((cps) => {
    if (hasIndependentPhysicalOperationMode(cps)) return cps;
    const remembered = cps?.id ? operationModeByCpsRef.current[cps.id] : null;
    return applyRememberedRuntimeMode(cps, remembered);
  }, []);

  const mergeCoordinatorSnapshotState = useCallback((acsmId, patch) => {
    const normalizedAcsmId = String(acsmId || '').toLowerCase();
    if (!COORDINATOR_ACSM_IDS.includes(normalizedAcsmId) || !patch) return;

    const prev = {
      ...emptyCoordinatorSnapshots(),
      ...(coordinatorSnapshotsRef.current || {}),
    };
    const next = {
      ...prev,
      [normalizedAcsmId]: mergeCoordinatorSnapshot(prev?.[normalizedAcsmId], patch),
    };
    coordinatorSnapshotsRef.current = next;
    setCoordinatorSnapshots(next);

    console.log('[COORDINATOR_SNAPSHOT_UPDATED]', {
      acsmId: normalizedAcsmId,
      has_acsm1: Boolean(next?.acsm1),
      has_acsm2: Boolean(next?.acsm2),
      has_acsm3: Boolean(next?.acsm3),
      next,
    });
  }, []);

  useEffect(() => {
    coordinatorSnapshotsRef.current = {
      ...emptyCoordinatorSnapshots(),
      ...(coordinatorSnapshots || {}),
    };
  }, [coordinatorSnapshots]);

  useEffect(() => {
    const analytics = stableSystemAnalytics || systemAnalytics;
    if (!hasDisplayableSystemAnalytics(analytics)) return;

    const level2Package = buildLevel2IntelligencePackage(analytics, acsmConfig);
    mergeCoordinatorSnapshotState(
      'acsm1',
      buildCoordinatorSnapshotPatch({
        acsmId: 'acsm1',
        topic: ACSM_TOPICS.globalOee,
        payload: {
          ...level2Package,
          systemAnalytics: analytics,
          reasoning: analytics?.reasoning || level2Package?.systemReasoning || null,
          learning: analytics?.learning || level2Package?.systemLearningModel || null,
          executiveSummary:
            analytics?.executiveSummary ||
            analytics?.reasoning?.executiveInterpretation ||
            level2Package?.executiveSummary ||
            null,
          managedCpsIds: acsmConfig.managedCpsIds || [],
        },
        systemAnalytics: analytics,
      })
    );
  }, [acsmConfig, mergeCoordinatorSnapshotState, stableSystemAnalytics, systemAnalytics]);

  const cpsAnalyticsRef = useRef({});
  useEffect(() => {
    cpsAnalyticsRef.current = cpsAnalytics;
  }, [cpsAnalytics]);

  useEffect(() => {
    if (playPhaseCPS.length === 0) {
      const empty = emptySystemAnalytics();
      const emptySignature = JSON.stringify(empty);
      stableSystemAnalyticsUpdatedAtRef.current = 0;

      if (JSON.stringify(systemAnalytics) !== emptySignature) {
        setSystemAnalytics(empty);
      }
      if (JSON.stringify(stableSystemAnalytics) !== emptySignature) {
        setStableSystemAnalytics(empty);
      }
      return undefined;
    }

    if (!hasDisplayableSystemAnalytics(systemAnalytics)) return undefined;

    if (hasStructuralSystemAnalyticsChange(stableSystemAnalytics, systemAnalytics)) {
      stableSystemAnalyticsUpdatedAtRef.current = Date.now();
      setStableSystemAnalytics(systemAnalytics);
      return undefined;
    }

    const now = Date.now();
    const elapsed = now - stableSystemAnalyticsUpdatedAtRef.current;
    const delay =
      elapsed >= SYSTEM_ANALYTICS_STABILIZATION_MS
        ? SYSTEM_ANALYTICS_STABILIZATION_MS
        : SYSTEM_ANALYTICS_STABILIZATION_MS - elapsed;

    const timerId = setTimeout(() => {
      setStableSystemAnalytics((prev) => {
        if (!hasSmoothSystemAnalyticsChange(prev, systemAnalytics)) {
          return prev;
        }

        stableSystemAnalyticsUpdatedAtRef.current = Date.now();
        return systemAnalytics;
      });
    }, delay);

    return () => clearTimeout(timerId);
  }, [playPhaseCPS.length, stableSystemAnalytics, systemAnalytics]);

  const setCpsAnalytics = useCallback((updater) => {
    setCpsAnalyticsState((prev) => {
      const resolved = typeof updater === 'function' ? updater(prev) : updater;

      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        return prev;
      }

      const next = { ...prev };
      Object.entries(resolved).forEach(([cpsId, entry]) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          next[cpsId] = entry;
          return;
        }
        next[cpsId] = mergeCpsAnalyticsEntry(prev[cpsId] || {}, entry);
      });
      return next;
    });
  }, []);

  const lastAutoUnplugRef = useRef({});
  const unplugRef = useRef(null);
  const maintenanceReturnRef = useRef({});

  const featPendingRef = useRef({});
  const featTimerRef = useRef({});
  const featLastEmitRef = useRef({});
  const stableSystemAnalyticsUpdatedAtRef = useRef(0);
  const level3ServiceRef = useRef(createLevel3CollaborativeLearningService());
  const level3PublisherRef = useRef(
    createLevel3PublisherService({
      topics: ACSM_TOPICS,
      onLog: (message) =>
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message,
          },
        ]),
    })
  );
  const supplyChainCoordinatorRef = useRef(createSupplyChainCoordinatorService());
  const supplyChainPublisherRef = useRef(
    createSupplyChainPublisherService({
      topics: ACSM_TOPICS,
      onLog: (message) =>
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message,
          },
        ]),
    })
  );
  const lastHcmCoordinatorSignatureRef = useRef('');

  const availableCPS = useMemo(() => {
    return Object.values(registry)
      .filter(Boolean)
      .filter((cps, index, arr) => arr.findIndex((x) => x.id === cps.id) === index);
  }, [registry]);

  const availableCPSRef = useRef([]);
  useEffect(() => {
    availableCPSRef.current = availableCPS;
  }, [availableCPS]);

  useEffect(() => {
    const cpsLai1 = availableCPS.find((cps) => normalizeCpsId(cps?.id) === 'cpslai1');
    if (!cpsLai1) return;
    publishCpsLai1LifecyclePhase(cpsLai1, getCpsLifecyclePhase(cpsLai1));
  }, [availableCPS, mqttConnectionEpoch, publishCpsLai1LifecyclePhase]);

  const availableCPSNames = useMemo(
    () =>
      Array.from(
        new Set(
          availableCPS
            .filter(Boolean)
            .map((cps) => cps.nome)
            .filter(Boolean)
        )
      ),
    [availableCPS]
  );

  const persistPlugEvent = useCallback(async (event) => {
    try {
      const response = await fetch('/api/plug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const data = await response.json().catch(() => null);
      const persistedEvent = data?.event || event;
      if (response.ok && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('plug-lifecycle-evidence-updated', {
            detail: {
              cpsId: persistedEvent?.cpsId || event?.cpsId || null,
              eventType: persistedEvent?.eventType || event?.eventType || event?.type || null,
              event: persistedEvent,
            },
          })
        );
      }
      return response.ok ? persistedEvent : null;
    } catch (e) {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[PLUG_LOG_ERROR] Failed to persist event: ${e?.message || e}`,
        },
      ]);
      return null;
    }
  }, []);

  const pushSystemEvent = useCallback((event) => {
    const store = knowledgeStoreRef.current;
    store.system.events = clampArray(
      [
        ...store.system.events,
        {
          ts: event?.ts || nowTs(),
          type: event?.type || 'system_event',
          cpsId: event?.cpsId || null,
          cpsName: event?.cpsName || null,
          message: event?.message || '',
          payload: event?.payload || null,
        },
      ],
      MAX_SYSTEM_EVENTS
    );
  }, []);

  const applyGovernanceProfileToState = useCallback(
    (cpsId, profile) => {
      const normalizedCpsId = normalizeCpsId(cpsId || profile?.cpsId);
      if (!normalizedCpsId) return;

      setGovernanceProfiles((prev) => ({
        ...prev,
        [normalizedCpsId]: profile || null,
      }));

      const patch = {
        governanceProfile: profile || null,
        governanceStatus: profile?.status || GOVERNANCE_STATUS.NOT_DEFINED,
      };

      setAddedCPS((prev) =>
        prev.map((cps) =>
          normalizeCpsId(cps?.id) === normalizedCpsId ? { ...cps, ...patch } : cps
        )
      );

      setRegistry((prev) => {
        const next = { ...prev };
        const baseObj =
          Object.values(next).find((cps) => normalizeCpsId(cps?.id) === normalizedCpsId) ||
          { id: normalizedCpsId };
        const updated = { ...baseObj, ...patch };
        [
          updated.nome,
          updated.id,
          updated.topic,
          updated.lifecycle?.cpsName,
          updated.lifecycle?.cpsId,
          updated.lifecycle?.baseTopic,
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase())
          .forEach((key) => {
            next[key] = updated;
          });
        return next;
      });
    },
    []
  );

  const ensureGovernanceProfileForCps = useCallback(
    async (cps) => {
      if (!cps?.id) return null;
      applyGovernanceProfileToState(cps.id, null);

      try {
        const response = await fetch(
          `${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(cps.id)}`,
          { method: 'GET', cache: 'no-store' }
        );
        const data = await response.json();
        if (response.ok) {
          const activeProfile = data?.activeProfile || data?.profile || null;
          applyGovernanceProfileToState(cps.id, activeProfile);
          return activeProfile;
        }
        throw new Error(data?.error || `Governance profile request failed (HTTP ${response.status}).`);
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE_WARN] Could not load active profile for ${cps.id}: ${error?.message || error}`,
          },
        ]);
      }

      return null;
    },
    [applyGovernanceProfileToState]
  );

  const refreshGovernanceProfile = useCallback(
    async (cpsId) => {
      const normalizedCpsId = normalizeCpsId(cpsId);
      if (!normalizedCpsId) return null;

      try {
        const response = await fetch(
          `${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(normalizedCpsId)}`,
          { method: 'GET', cache: 'no-store' }
        );
        const data = await response.json();
        if (response.ok) {
          const activeProfile = data?.activeProfile || data?.profile || null;
          applyGovernanceProfileToState(normalizedCpsId, activeProfile);
          return activeProfile;
        }
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE_WARN] Failed to refresh ${normalizedCpsId}: ${error?.message || error}`,
          },
        ]);
      }

      return null;
    },
    [applyGovernanceProfileToState]
  );

  const approveGovernanceProfile = useCallback(
    async (cpsId) => {
      const normalizedCpsId = normalizeCpsId(cpsId);
      if (!normalizedCpsId) return false;

      try {
        const response = await fetch(
          `${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(normalizedCpsId)}/approve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvedBy: 'human-operator' }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Governance approval failed.');
        const activeProfile = await refreshGovernanceProfile(normalizedCpsId);
        if (activeProfile?.status !== GOVERNANCE_STATUS.APPROVED) {
          throw new Error('Approval saved, but the active profile could not be refreshed.');
        }
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE] ${normalizedCpsId} profile approved by human-operator.`,
          },
        ]);
        return true;
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE_ERROR] ${error?.message || error}`,
          },
        ]);
        return false;
      }
    },
    [refreshGovernanceProfile]
  );

  const updateGovernanceProfile = useCallback(
    async (cpsId, policies) => {
      const normalizedCpsId = normalizeCpsId(cpsId);
      if (!normalizedCpsId) return null;

      try {
        const response = await fetch(
          `${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(normalizedCpsId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              updatePolicies: true,
              policies,
              updatedBy: 'human-operator',
            }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Governance update failed.');
        applyGovernanceProfileToState(normalizedCpsId, data.profile);
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message:
              `[GOVERNANCE] ${normalizedCpsId} profile ` +
              `${data.profile?.profileId || '-'} v${data.profile?.profileVersion || '-'} updated; ` +
              `status=${data.profile?.status || 'PENDING_APPROVAL'}.`,
          },
        ]);
        return data.profile;
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE_UPDATE_ERROR] ${error?.message || error}`,
          },
        ]);
        throw error;
      }
    },
    [applyGovernanceProfileToState]
  );

  const rejectGovernanceProfile = useCallback(
    async (cpsId) => {
      const normalizedCpsId = normalizeCpsId(cpsId);
      if (!normalizedCpsId) return false;

      try {
        const response = await fetch(
          `${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(normalizedCpsId)}/reject`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rejectedBy: 'human-operator' }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Governance rejection failed.');
        applyGovernanceProfileToState(normalizedCpsId, data.profile);
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE] ${normalizedCpsId} profile rejected by human-operator.`,
          },
        ]);
        return true;
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GOVERNANCE_ERROR] ${error?.message || error}`,
          },
        ]);
        return false;
      }
    },
    [applyGovernanceProfileToState]
  );

  const registerHcmKnowledgeItem = useCallback(async (payload = {}) => {
    const cpsId = normalizeCpsId(payload.cpsId || payload.originalKnowledge?.cpsId);
    const source = String(payload.source || 'cps');
    const contentSignature = makeLocalKnowledgeSignature({
      cpsId,
      source,
      originalKnowledge: payload.originalKnowledge,
    });
    const sourceSignatures = lastPersistedKnowledgeSignatureRef.current[cpsId] || {};
    const inFlightSourceSignatures = inFlightKnowledgeSignatureRef.current[cpsId] || {};
    const previous = sourceSignatures[source];
    const inFlight = inFlightSourceSignatures[source];
    const hasIncomingEpisode = Boolean(payload.episodeId);
    const needsPersistedEpisodeCorrelation =
      hasIncomingEpisode &&
      previous?.contentSignature === contentSignature &&
      !previous?.episodeId;
    const needsInFlightEpisodeCorrelation =
      hasIncomingEpisode &&
      inFlight?.contentSignature === contentSignature &&
      !inFlight?.episodeId;

    if (previous?.contentSignature === contentSignature && !needsPersistedEpisodeCorrelation) {
      return null;
    }
    if (inFlight?.contentSignature === contentSignature && !needsInFlightEpisodeCorrelation) {
      return null;
    }

    inFlightKnowledgeSignatureRef.current = {
      ...inFlightKnowledgeSignatureRef.current,
      [cpsId]: {
        ...inFlightSourceSignatures,
        [source]: {
          contentSignature,
          episodeId: payload.episodeId || '',
        },
      },
    };

    try {
      const response = await fetch(`${HCM_API_BASE}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || 'Knowledge item registration failed.');
      }
      const knowledgeItem = body?.knowledgeItem || null;
      const latestInFlight = inFlightKnowledgeSignatureRef.current[cpsId]?.[source];
      if (!latestInFlight || latestInFlight.contentSignature === contentSignature) {
        lastPersistedKnowledgeSignatureRef.current = {
          ...lastPersistedKnowledgeSignatureRef.current,
          [cpsId]: {
            ...(lastPersistedKnowledgeSignatureRef.current[cpsId] || {}),
            [source]: {
              contentSignature,
              episodeId: knowledgeItem?.episodeId || payload.episodeId || '',
            },
          },
        };
      }
      return knowledgeItem;
    } catch (error) {
      console.warn('[HCM_KNOWLEDGE_WARN]', error?.message || error);
      return null;
    } finally {
      const latestInFlight = inFlightKnowledgeSignatureRef.current[cpsId]?.[source];
      if (latestInFlight?.contentSignature === contentSignature) {
        inFlightKnowledgeSignatureRef.current = {
          ...inFlightKnowledgeSignatureRef.current,
          [cpsId]: {
            ...(inFlightKnowledgeSignatureRef.current[cpsId] || {}),
            [source]: null,
          },
        };
      }
    }
  }, []);

  const openLocalCognitiveEpisodeForRecommendation = useCallback(async (payload = {}) => {
    try {
      const recommendation =
        payload.recommendation ||
        payload.reasoning?.recommendation ||
        payload.learning?.recommendation ||
        'Local governable recommendation.';
      const response = await fetch(`${HCM_API_BASE}/episode/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'local_recommendation',
          source: 'cps',
          cpsId: payload.cpsId,
          targetCps: payload.cpsId,
          recommendation,
          risk: payload.reasoning?.riskLevel || payload.learning?.state || null,
          oee: payload.oee?.oee ?? payload.oee?.current ?? payload.oee ?? null,
          contextSnapshot: payload,
        }),
      });
      const opened = await response.json().catch(() => null);
      const episodeId = opened?.episode?.episodeId;
      if (!response.ok || !episodeId) return null;

      const events = [
        ['learning', payload.learning],
        ['reasoning', payload.reasoning],
        ['recommendation', {
          recommendation,
          governableAction: payload.governableAction,
          action: payload.action,
          variation: payload.variation,
          requestedValue: payload.requestedValue,
          unit: payload.unit || '%',
        }],
      ].filter(([, content]) => content);

      await Promise.allSettled(
        events.map(([eventType, content]) =>
          fetch(`${HCM_API_BASE}/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              episodeId,
              source: 'cps',
              eventType,
              content,
            }),
          })
        )
      );

      return episodeId;
    } catch (error) {
      console.warn('[HCM_LOCAL_EPISODE_WARN]', error?.message || error);
      return null;
    }
  }, []);

  const checkGovernanceAction = useCallback(async (request = {}) => {
    try {
      const response = await fetch(`${GOVERNANCE_API_BASE}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Governance check failed.');
      if (data?.pendingActions) setPendingGovernanceActions(data.pendingActions);
      if (data?.profile) applyGovernanceProfileToState(data.profile.cpsId, data.profile);
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message:
            `[GOVERNANCE_CHECK] ${request.cpsId} ${request.action} ` +
            `${request.variation}${request.unit || '%'} -> ${data.decision}` +
            (data.execution?.executionStatus ? ` / execution=${data.execution.executionStatus}` : ''),
        },
      ]);
      return data;
    } catch (error) {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[GOVERNANCE_CHECK_ERROR] ${error?.message || error}`,
        },
      ]);
      return null;
    }
  }, [applyGovernanceProfileToState]);

  const decidePendingGovernanceAction = useCallback(async (actionId, decision) => {
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    const endpoint = normalizedDecision === 'approved' ? 'approve' : 'reject';

    try {
      const response = await fetch(
        `${GOVERNANCE_API_BASE}/action/${encodeURIComponent(actionId)}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decidedBy: 'human-operator' }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Governance action decision failed.');
      if (data?.pendingActions) setPendingGovernanceActions(data.pendingActions);
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[GOVERNANCE_ACTION] ${actionId} ${endpoint.toUpperCase()} by human-operator.`,
        },
      ]);
      return true;
    } catch (error) {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[GOVERNANCE_ACTION_ERROR] ${error?.message || error}`,
        },
      ]);
      return false;
    }
  }, []);

  const requestLifecyclePlayGate = useCallback(async (cps) => {
    const cpsId = normalizeCpsId(cps?.id || cps?.cpsId);
    try {
      const response = await fetch(
        `${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(cpsId)}/play-gate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      const result = await response.json();
      if (!response.ok || result?.ok !== true) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message:
              `[PLAY_NOT_ALLOWED] ${cps?.nome || cpsId} blocked by backend: ` +
              `${result?.reason || 'GOVERNANCE_APPROVAL_REQUIRED'} ` +
              `(governanceStatus=${result?.governanceStatus || 'NOT_DEFINED'}).`,
          },
        ]);
        return result || {
          ok: false,
          reason: 'GOVERNANCE_APPROVAL_REQUIRED',
          governanceStatus: getGovernanceStatus(cps),
        };
      }
      return result;
    } catch (error) {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[PLAY_NOT_ALLOWED] Backend governance gate unavailable: ${error?.message || error}.`,
        },
      ]);
      return { ok: false, reason: 'GOVERNANCE_GATE_UNAVAILABLE' };
    }
  }, []);

  const updateKnowledgeStoreFromAnalytics = useCallback((cpsId, payload) => {
    const normalizedCpsId = normalizeCpsId(cpsId);
    if (!normalizedCpsId) return;

    const store = knowledgeStoreRef.current;
    const registryCps = getRegistryCpsForEntry(
      { cpsId: normalizedCpsId },
      registryRef.current || {}
    );

    if (!store.cps[normalizedCpsId]) {
      store.cps[normalizedCpsId] = {
        cpsId: normalizedCpsId,
        cpsName: registryCps?.nome || cpsId,
        baseTopic: registryCps?.topic || '',
        history: [],
        reasoningDocs: [],
        learningDocs: [],
      };
    }

  const baselineEvidence = extractLocalBaselineEvidence(payload);
  const previousSnapshot = knowledgeStoreRef.current.cps[normalizedCpsId]?.history?.at(-1);
  const hasOeeField = Object.prototype.hasOwnProperty.call(payload || {}, 'oee');
  const storedOee =
    !hasOeeField && previousSnapshot?.oee
      ? previousSnapshot.oee
      : payload?.oee && typeof payload.oee === 'object'
      ? payload.oee
      : {
          oee: payload?.oee ?? null,
          availability: payload?.availability ?? null,
          performance: payload?.performanceAccumulated ?? payload?.performance ?? null,
          quality: payload?.quality ?? null,
        };

  const entry = {
      ts: payload?.ts || nowTs(),
      cpsId: normalizedCpsId,
      cpsName: payload?.cpsName || registryCps?.nome || normalizedCpsId,
      baseTopic: payload?.baseTopic || registryCps?.topic || '',
      oee: storedOee,
      learning: payload?.learning || null,
      reasoning: payload?.reasoning || null,
      statistics: payload?.statistics || null,
      evidence: baselineEvidence,
      operationalData: payload?.operationalData || registryCps?.operationalData || null,
      globalState: payload?.globalState || registryCps?.globalState || null,
      lifecycle: payload?.lifecycle || registryCps?.lifecycle || null,
      lifecyclePhase: getCpsLifecyclePhase(payload) || getCpsLifecyclePhase(registryCps) || null,
      raw: payload || null,
    };

    store.cps[normalizedCpsId].history = clampArray(
      [...store.cps[normalizedCpsId].history, entry],
      MAX_HISTORY_PER_CPS
    );

    if (payload?.reasoning) {
      store.cps[normalizedCpsId].reasoningDocs = clampArray(
        [
          ...store.cps[normalizedCpsId].reasoningDocs,
          {
            ts: entry.ts,
            data: payload.reasoning,
          },
        ],
        100
      );
    }

    if (payload?.learning) {
      store.cps[normalizedCpsId].learningDocs = clampArray(
        [
          ...store.cps[normalizedCpsId].learningDocs,
          {
            ts: entry.ts,
            data: payload.learning,
          },
        ],
        100
      );
    }

    setIngestionBuffer((prev) =>
      clampArray(
        [
          ...prev,
          {
            ts: entry.ts,
            cpsId: normalizedCpsId,
            cpsName: entry.cpsName,
            baseTopic: entry.baseTopic,
            oee: entry.oee,
            learning: entry.learning,
            reasoning: entry.reasoning,
            statistics: entry.statistics,
            operationalData: entry.operationalData,
            lifecycle: entry.lifecycle,
            lifecyclePhase: entry.lifecyclePhase,
          },
        ],
        MAX_INGESTION_BUFFER
      )
    );
  }, []);

  const runSystemAnalytics = useCallback(() => {
    const store = knowledgeStoreRef.current;
    const registrySnapshot = registryRef.current || {};
    const globalCpsMetrics = buildGlobalCpsMetrics(store, registrySnapshot);
    const cpsEntries = Object.values(store.cps || {}).filter(
      (entry) =>
        keepManagedValue(entry?.cpsId || entry?.baseTopic, ACTIVE_ACSM) &&
        isKnowledgeEntryInPlay(entry, registrySnapshot)
    );

    if (!cpsEntries.length) {
      const empty = emptySystemAnalytics();
      stableSystemAnalyticsUpdatedAtRef.current = 0;
      setSystemAnalytics(empty);
      setStableSystemAnalytics(empty);
      return empty;
    }

    const latest = cpsEntries.map((c) => getLatestPlaySnapshot(c)).filter(Boolean);

    if (!latest.length) {
      const empty = emptySystemAnalytics();
      stableSystemAnalyticsUpdatedAtRef.current = 0;
      setSystemAnalytics(empty);
      setStableSystemAnalytics(empty);
      return empty;
    }

    const globalOEE = {
      availability: nullableMean(latest.map((x) => x?.oee?.availability)),
      performance: nullableMean(latest.map((x) => x?.oee?.performance)),
      quality: nullableMean(latest.map((x) => x?.oee?.quality)),
      oee: nullableMean(
        latest.map((x) => x?.oee?.oee ?? x?.oee?.value ?? x?.oee?.current ?? x?.oee)
      ),
    };
    const eligibleCpsIds = latest.map((snap) => snap.cpsId).filter(Boolean).sort();
    const sameEligiblePopulation = (snapshot) => {
      const ids = Array.isArray(snapshot?.participantCpsIds)
        ? snapshot.participantCpsIds.filter(Boolean).sort()
        : [];
      return (
        ids.length === eligibleCpsIds.length &&
        ids.every((id, index) => id === eligibleCpsIds[index])
      );
    };

    const criticalityRanking = filterContributionRanking(
      latest.map((snap) => ({
        cpsId: snap.cpsId,
        cpsName: snap.cpsName,
        baseTopic: snap.baseTopic,
        dominantLoss:
          snap?.reasoning?.dominantLoss ??
          snap?.reasoning?.dominantLossNow ??
          snap?.learning?.dominantLoss ??
          null,
        score: computeCriticalityFromSnapshot(snap),
      }))
      .sort((a, b) => b.score - a.score),
    ACTIVE_ACSM
  );

    const criticalCPS = criticalityRanking[0] || null;

    let bottleneck = null;
    latest.forEach((snap) => {
      const cycle = toNumber(snap?.operationalData?.cycleTimeMs, -1);
      if (cycle < 0) return;
      if (!bottleneck || cycle > bottleneck.cycleTimeMs) {
        bottleneck = {
          cpsId: snap.cpsId,
          cpsName: snap.cpsName,
          cycleTimeMs: cycle,
          reason: 'highest_cycle_time',
        };
      }
    });

    const cycles = latest
      .map((x) => toNumber(x?.operationalData?.cycleTimeMs))
      .filter((x) => Number.isFinite(x) && x > 0);

    const synchronizationIssue =
      cycles.length >= 2 ? Math.max(...cycles) / Math.min(...cycles) > 1.5 : false;

    const oees = latest
      .map((x) => toNumber(x?.oee?.oee ?? x?.oee?.value ?? x?.oee?.current ?? x?.oee))
      .filter((x) => Number.isFinite(x));

    const cascadeEffect =
      oees.length >= 2
        ? Math.max(...oees) - Math.min(...oees) < 0.08 && mean(oees) < 0.75
        : false;

    const dominantLosses = normalizeManagedArrayEntries(latest.map((snap) => {
      const availabilityLoss = Math.max(0, 1 - (toNumber(snap?.oee?.availability, 0) || 0));
      const performanceLoss = Math.max(0, 1 - (toNumber(snap?.oee?.performance, 0) || 0));
      const qualityLoss = Math.max(0, 1 - (toNumber(snap?.oee?.quality, 0) || 0));

      const dominantDimension =
        availabilityLoss >= performanceLoss && availabilityLoss >= qualityLoss
          ? 'availability'
          : performanceLoss >= availabilityLoss && performanceLoss >= qualityLoss
            ? 'performance'
            : 'quality';

      return {
        cpsId: snap.cpsId,
        cpsName: snap.cpsName,
        availabilityLoss: Number(availabilityLoss.toFixed(4)),
        performanceLoss: Number(performanceLoss.toFixed(4)),
        qualityLoss: Number(qualityLoss.toFixed(4)),
        dominantDimension,
      };
    }));

    const recentSnapshots = (store.system.snapshots || []).filter(sameEligiblePopulation);
    const predictedGlobalOEE =
      recentSnapshots.length >= 1
        ? (() => {
            const last = toNumber(recentSnapshots.at(-1)?.globalOEE?.oee, globalOEE.oee);
            if (last === null) return null;
            const prev = toNumber(recentSnapshots.at(-2)?.globalOEE?.oee, last);
            return Number(Math.max(0, Math.min(1, last + (last - prev))).toFixed(4));
          })()
        : null;

    const learnedPattern = classifyGlobalPattern(
      globalOEE.oee,
      cascadeEffect,
      synchronizationIssue
    );

    const riskLevel = inferRiskLevel(
      globalOEE.oee,
      predictedGlobalOEE,
      criticalCPS?.score || 0,
      cascadeEffect
    );

    let confidence = 0.6;
    if (latest.length >= 3) confidence += 0.1;
    if (predictedGlobalOEE !== null) confidence += 0.1;
    if (criticalCPS?.score >= 0.4) confidence += 0.1;
    if (cascadeEffect || synchronizationIssue) confidence += 0.1;
    confidence = Number(Math.min(0.95, confidence).toFixed(2));

    const bottleneckMigrating =
      recentSnapshots.length >= 2
        ? new Set(
            recentSnapshots
              .slice(-3)
              .map((s) => s?.bottleneck?.cpsId)
              .filter(Boolean)
          ).size > 1
        : false;

    const recommendation = criticalCPS?.cpsId
      ? riskLevel === 'high'
        ? `Prioritize intervention on ${criticalCPS.cpsId} and inspect dominant losses affecting the global OEE.`
        : synchronizationIssue
          ? 'Adjust synchronization between CPS and review handoff timing between assets.'
          : bottleneck?.cpsId
            ? `Monitor ${bottleneck.cpsId} as the current bottleneck and rebalance workload if possible.`
            : 'Maintain current coordination and continue monitoring.'
      : 'Collect more data for system-level recommendation.';

    const explanation =
      `Global OEE is ${(globalOEE.oee * 100).toFixed(1)}%. ` +
      `${criticalCPS?.cpsId ? `${criticalCPS.cpsId} is currently the most critical CPS. ` : ''}` +
      `${bottleneck?.cpsId ? `${bottleneck.cpsId} acts as the current bottleneck. ` : ''}` +
      `${cascadeEffect ? 'There are signs of possible cascade effect across CPS. ' : ''}` +
      `${synchronizationIssue ? 'Cycle mismatch suggests poor synchronization between assets. ' : ''}` +
      `Learned pattern: ${learnedPattern}. Risk level: ${riskLevel}.`;

    const analytics = normalizeSystemAnalytics({
      ts: nowTs(),
      cpsCount: latest.length,
      globalOEE,
      criticalCPS,
      criticalityRanking,
      bottleneck,
      cascadeEffect,
      synchronizationIssue,
      bottleneckMigrating,
      dominantLosses,
      learnedPattern,
      predictedGlobalOEE,
      riskLevel,
      confidence,
      recommendation,
      explanation,
      coordinatorOutput: {
        globalOEE: globalOEE.oee,
        dominantLosses,
        criticalCPS: criticalCPS?.cpsId || null,
        learnedPattern,
        predictedRisk: riskLevel,
        recommendation,
        confidence,
        explanation,
      },
    });

    store.system.snapshots = clampArray(
      [
        ...store.system.snapshots,
        {
          ts: analytics.ts,
          globalOEE,
          criticalCPS,
          bottleneck,
          participantCpsIds: eligibleCpsIds,
          cpsCount: eligibleCpsIds.length,
          cascadeEffect,
          synchronizationIssue,
          learnedPattern,
          riskLevel,
        },
      ],
      MAX_SYSTEM_SNAPSHOTS
    );

    store.system.learningHistory = clampArray(
      [
        ...(store.system.learningHistory || []),
        {
          ts: analytics.ts,
          systemOEE: globalOEE.oee,
          systemAvailability: globalOEE.availability,
          systemPerformance: globalOEE.performance,
          systemQuality: globalOEE.quality,
          cpsMetrics: globalCpsMetrics,
        },
      ],
      MAX_SYSTEM_LEARNING_HISTORY
    );

    const systemLearning = normalizeSystemAnalytics(buildSystemLearning(store.system.learningHistory));

    analytics.learningState = systemLearning.learningState;
    analytics.learningPattern = systemLearning.learningPattern;
    analytics.globalDriftScore = systemLearning.globalDriftScore;
    analytics.predictedSystemOEE = systemLearning.predictedSystemOEE;
    analytics.dominantChronicLoss = systemLearning.dominantChronicLoss;
    analytics.cpsContributionRanking = systemLearning.cpsContributionRanking;
    analytics.recommendation = systemLearning.recommendation || analytics.recommendation;
    analytics.confidence = systemLearning.confidence;
    analytics.derivedLearning = systemLearning.derivedLearning;
    analytics.systemEvidence = systemLearning.systemEvidence;
    analytics.learningConsensus = systemLearning.learningConsensus;
    analytics.fleetDriftIndex = systemLearning.fleetDriftIndex;
    analytics.fleetAnomalyIndex = systemLearning.fleetAnomalyIndex;
    analytics.stabilityIndex = systemLearning.stabilityIndex;
    analytics.supportingSignals = systemLearning.supportingSignals;
    analytics.riskDrivers = systemLearning.riskDrivers;
    analytics.historySummary = systemLearning.historySummary;

    const systemIntelligence = buildSystemIntelligence({
      latest,
      globalOEE,
      criticalityRanking: analytics.criticalityRanking,
      criticalCPS: analytics.criticalCPS,
      dominantLosses: analytics.dominantLosses,
      learnedPattern: analytics.learningPattern || learnedPattern,
      riskLevel: analytics.riskLevel || riskLevel,
      confidence: analytics.confidence,
      systemLearning,
      cascadeEffect,
      synchronizationIssue,
      predictedGlobalOEE: analytics.predictedSystemOEE ?? predictedGlobalOEE,
    });

    analytics.systemLearningModel = systemIntelligence.systemLearningModel;
    analytics.systemEvidenceList = systemIntelligence.systemEvidence;
    analytics.systemCausality = systemIntelligence.systemCausality;
    analytics.criticalityRanking = systemIntelligence.criticalityRanking;
    analytics.criticality = systemIntelligence.criticalityRanking;
    analytics.systemAnomaly = systemIntelligence.systemAnomaly;
    analytics.systemForecast = systemIntelligence.systemForecast;
    analytics.systemReasoning = systemIntelligence.systemReasoning;
    analytics.reasoning = {
      ...(analytics.reasoning || {}),
      ...systemIntelligence.systemReasoning,
      supportingEvidence: systemIntelligence.systemEvidence,
      systemCausality: systemIntelligence.systemCausality,
      systemLearningModel: systemIntelligence.systemLearningModel,
      systemForecast: systemIntelligence.systemForecast,
    };
    analytics.trend = systemIntelligence.trend;
    analytics.recommendation =
      systemIntelligence.systemReasoning?.recommendation || analytics.recommendation;
    analytics.systemEvidence = {
      ...(analytics.systemEvidence || {}),
      narrative: systemIntelligence.systemEvidence,
    };

    analytics.coordinatorOutput = {
      ...(analytics.coordinatorOutput || {}),
      learningState: analytics.learningState,
      learningPattern: analytics.learningPattern,
      globalDriftScore: analytics.globalDriftScore,
      predictedSystemOEE: analytics.predictedSystemOEE,
      dominantChronicLoss: analytics.dominantChronicLoss,
      confidence: analytics.confidence,
      recommendation: analytics.recommendation,
      systemLearningModel: analytics.systemLearningModel,
      systemEvidence: analytics.systemEvidenceList,
      systemCausality: analytics.systemCausality,
      criticalityRanking: analytics.criticalityRanking,
      systemAnomaly: analytics.systemAnomaly,
      systemForecast: analytics.systemForecast,
      systemReasoning: analytics.systemReasoning,
    };

    setSystemAnalytics((prev) => ({
      ...prev,
      ...analytics,
      systemEvidence:
        analytics.systemEvidence && Object.keys(analytics.systemEvidence).length
          ? analytics.systemEvidence
          : prev.systemEvidence || {},
      actionPlan:
        analytics.actionPlan && Object.keys(analytics.actionPlan).length
          ? analytics.actionPlan
          : prev.actionPlan || {},
      systemState:
        analytics.systemState && Object.keys(analytics.systemState).length
          ? analytics.systemState
          : prev.systemState || {},
      supportingSignals: analytics.supportingSignals || [],
      riskDrivers: analytics.riskDrivers || [],
      coordinationMode: analytics.coordinationMode ?? prev.coordinationMode ?? null,
      crossCpsPatterns: analytics.crossCpsPatterns || [],
      riskSummary:
        analytics.riskSummary && Object.keys(analytics.riskSummary).length
          ? analytics.riskSummary
          : prev.riskSummary || {},
      recommendedFocus: analytics.recommendedFocus ?? prev.recommendedFocus ?? null,
      learningConsensus: analytics.learningConsensus ?? prev.learningConsensus ?? null,
      fleetAnomalyIndex: analytics.fleetAnomalyIndex ?? prev.fleetAnomalyIndex ?? null,
      fleetDriftIndex: analytics.fleetDriftIndex ?? prev.fleetDriftIndex ?? null,
      stabilityIndex: analytics.stabilityIndex ?? prev.stabilityIndex ?? null,
      derivedLearning:
        analytics.derivedLearning && Object.keys(analytics.derivedLearning).length
          ? analytics.derivedLearning
          : prev.derivedLearning || {},
      predictedRisk:
        analytics.predictedRisk && Object.keys(analytics.predictedRisk).length
          ? analytics.predictedRisk
          : prev.predictedRisk || {},
      historySummary:
        analytics.historySummary && Object.keys(analytics.historySummary).length
          ? analytics.historySummary
          : prev.historySummary || {},
    }));

    return analytics;
  }, []);

  const getCoordinatorOutput = useCallback(() => {
    return systemAnalytics?.coordinatorOutput || null;
  }, [systemAnalytics]);

  const getSupplyChainCoordinator = useCallback(() => {
    return knowledgeStoreRef.current?.supplychain || emptySupplyChainCoordinator();
  }, []);

  const getKnowledgeStore = useCallback(() => knowledgeStoreRef.current, []);

  const exportSystemSnapshot = useCallback(() => {
    return {
      exportedAt: new Date().toISOString(),
      registry,
      addedCPS,
      ingestionBuffer,
      cpsAnalytics,
      systemAnalytics,
      knowledgeStore: knowledgeStoreRef.current,
      multiAcsmInputs,
      supplyChainCoordinator: knowledgeStoreRef.current?.supplychain || emptySupplyChainCoordinator(),
    };
  }, [registry, addedCPS, ingestionBuffer, cpsAnalytics, systemAnalytics, multiAcsmInputs]);

  const loadLevel3PublisherPreferences = useCallback(() => {
    if (typeof window === 'undefined') {
      return {
        lastPublishAt: null,
        autoPublishEnabled: false,
        lastPayload: null,
      };
    }

    const lastPublishAt = localStorage.getItem(LEVEL3_LAST_PUBLISH_AT_KEY);
    const autoPublishEnabled =
      localStorage.getItem(LEVEL3_AUTO_PUBLISH_ENABLED_KEY) === 'true';
    const lastPayload = safeParseJson(localStorage.getItem(LEVEL3_LAST_PAYLOAD_KEY));

    setLevel3LastPublishAt(lastPublishAt || null);
    setLevel3AutoPublishEnabled(autoPublishEnabled);
    if (lastPayload) {
      setSupplyChainPackage(normalizeSupplyChainPackage(lastPayload));
    }

    return {
      lastPublishAt: lastPublishAt || null,
      autoPublishEnabled,
      lastPayload,
    };
  }, []);

  const saveLevel3PublisherPreferences = useCallback(
    (preferences = {}) => {
      if (typeof window === 'undefined') return false;

      const lastPublishAt =
        preferences.lastPublishAt ?? preferences.level3LastPublishAt ?? level3LastPublishAt;
      const autoPublishEnabled =
        preferences.autoPublishEnabled ??
        preferences.level3AutoPublishEnabled ??
        level3AutoPublishEnabled;
      const lastPayload =
        preferences.lastPayload ?? preferences.supplyChainPackage ?? supplyChainPackage;

      if (lastPublishAt) {
        localStorage.setItem(LEVEL3_LAST_PUBLISH_AT_KEY, lastPublishAt);
      }
      localStorage.setItem(
        LEVEL3_AUTO_PUBLISH_ENABLED_KEY,
        String(Boolean(autoPublishEnabled))
      );
      if (lastPayload) {
        localStorage.setItem(
          LEVEL3_LAST_PAYLOAD_KEY,
          JSON.stringify(normalizeSupplyChainPackage(lastPayload))
        );
      }

      return true;
    },
    [level3AutoPublishEnabled, level3LastPublishAt, supplyChainPackage]
  );

  useEffect(() => {
    loadLevel3PublisherPreferences();
  }, [loadLevel3PublisherPreferences]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(
      LEVEL3_AUTO_PUBLISH_ENABLED_KEY,
      String(Boolean(level3AutoPublishEnabled))
    );
  }, [level3AutoPublishEnabled]);

  const buildLevel3KnowledgePackage = useCallback(
    (requestedAcsmId = 'acsm1') => {
      const publisherAcsmId = String(requestedAcsmId || acsmConfig.id || 'acsm1').toLowerCase();
      const activeProviderAcsmId = String(acsmConfig.id || '').toLowerCase();
      if (activeProviderAcsmId !== 'acsm1' || publisherAcsmId !== 'acsm1') return null;

      const analytics = stableSystemAnalytics || systemAnalytics || {};
      const fallbackAcsm1Input = hasDisplayableSystemAnalytics(analytics)
        ? buildLevel2IntelligencePackage(analytics, acsmConfig)
        : null;
      const localPatch = fallbackAcsm1Input
        ? buildCoordinatorSnapshotPatch({
            acsmId: 'acsm1',
            topic: ACSM_TOPICS.globalOee,
            payload: {
              ...fallbackAcsm1Input,
              systemAnalytics: analytics,
              reasoning: analytics?.reasoning || fallbackAcsm1Input?.systemReasoning || null,
              learning: analytics?.learning || fallbackAcsm1Input?.systemLearningModel || null,
              executiveSummary:
                analytics?.executiveSummary ||
                analytics?.reasoning?.executiveInterpretation ||
                fallbackAcsm1Input?.executiveSummary ||
                null,
              managedCpsIds: acsmConfig.managedCpsIds || [],
            },
            systemAnalytics: analytics,
          })
        : null;
      const snapshots = {
        ...emptyCoordinatorSnapshots(),
        ...(coordinatorSnapshotsRef.current || {}),
        acsm1: mergeCoordinatorSnapshot(coordinatorSnapshotsRef.current?.acsm1, localPatch),
      };
      const coordinatorEnvelope = buildCoordinatorPayload(snapshots);

      return normalizeCoordinatorSupplyChainPayload(coordinatorEnvelope);
    },
    [acsmConfig, stableSystemAnalytics, systemAnalytics]
  );

  const publishLevel3KnowledgePackage = useCallback(
    (requestedAcsmId = 'acsm1') => {
      const publisherAcsmId = String(requestedAcsmId || acsmConfig.id || 'acsm1').toLowerCase();
      const activeProviderAcsmId = String(acsmConfig.id || '').toLowerCase();
      if (activeProviderAcsmId !== 'acsm1' || publisherAcsmId !== 'acsm1') {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[SUPPLYCHAIN_PUBLISH_SKIP] ${activeProviderAcsmId || publisherAcsmId} is not allowed to publish to coordinator`,
          },
        ]);
        return false;
      }

      const builtPackage = buildLevel3KnowledgePackage('acsm1');
      if (!builtPackage) return false;

      const payload = normalizeCoordinatorSupplyChainPayload(builtPackage);
      const publishedAt = new Date().toISOString();
      const client = mqttClientRef.current;
      const currentSnapshots = {
        ...emptyCoordinatorSnapshots(),
        ...(coordinatorSnapshotsRef.current || {}),
      };
      const snapshotPresence = getCoordinatorSnapshotPresence(payload.coordinatorPayload);
      const missingAcsms = COORDINATOR_ACSM_IDS.filter((acsmId) => !snapshotPresence[acsmId]);
      const hasAnyCoordinatorSnapshot = Object.values(payload.coordinatorPayload || {}).some(hasKeys);
      const finalPublishInputLog = {
        has_acsm1: Boolean(coordinatorSnapshotsRef.current?.acsm1),
        has_acsm2: Boolean(coordinatorSnapshotsRef.current?.acsm2),
        has_acsm3: Boolean(coordinatorSnapshotsRef.current?.acsm3),
        snapshots: coordinatorSnapshotsRef.current,
        messageType: payload.messageType,
        source: payload.source,
      };
      const finalPublishLog = [
        '[COORDINATOR_FINAL_PUBLISH]',
        `topic=${SUPPLY_CHAIN_REASONING_TOPIC}`,
        `messageType=${payload.messageType}`,
        `source=${payload.source}`,
        `has_acsm1=${Boolean(snapshotPresence.acsm1)}`,
        `has_acsm2=${Boolean(snapshotPresence.acsm2)}`,
        `has_acsm3=${Boolean(snapshotPresence.acsm3)}`,
      ].join('\n');
      const debugSummary = {
        topic: SUPPLY_CHAIN_REASONING_TOPIC,
        present: snapshotPresence,
        missing: missingAcsms,
        messageType: payload.messageType,
        acsms: COORDINATOR_ACSM_IDS.reduce(
          (acc, acsmId) => ({
            ...acc,
            [acsmId]: {
              hasSystemAnalytics: hasKeys(payload.coordinatorPayload?.[acsmId]?.systemAnalytics),
              hasReasoning: hasKeys(payload.coordinatorPayload?.[acsmId]?.reasoning),
              hasLearning: hasKeys(payload.coordinatorPayload?.[acsmId]?.learning),
              hasKnowledge: hasKeys(payload.coordinatorPayload?.[acsmId]?.knowledge),
              lastUpdate: payload.coordinatorPayload?.[acsmId]?.lastUpdate || null,
            },
          }),
          {}
        ),
      };

      if (!hasAnyCoordinatorSnapshot) {
        console.log('[COORDINATOR_FINAL_PUBLISH_INPUT]', finalPublishInputLog);
        console.warn('[COORDINATOR_PUBLISH_DEBUG] Publish blocked because all ACSM snapshots are empty.', debugSummary);
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: '[SUPPLYCHAIN_PUBLISH_SKIP] Coordinator payload is empty; nothing published',
          },
        ]);
        return false;
      }

      setSupplyChainPackage(payload);
      setLevel3LastPublishAt(publishedAt);
      if (typeof window !== 'undefined') {
        localStorage.setItem(LEVEL3_LAST_PUBLISH_AT_KEY, publishedAt);
        localStorage.setItem(LEVEL3_LAST_PAYLOAD_KEY, JSON.stringify(payload));
        localStorage.setItem(
          LEVEL3_AUTO_PUBLISH_ENABLED_KEY,
          String(Boolean(level3AutoPublishEnabled))
        );
      }

      if (!client || client.connected === false) {
        console.log('[COORDINATOR_FINAL_PUBLISH_INPUT]', finalPublishInputLog);
        console.warn('[COORDINATOR_PUBLISH_DEBUG] MQTT disconnected; payload stored locally.', debugSummary);
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: '[SUPPLYCHAIN_PUBLISH_WARN] MQTT client not connected; package stored locally',
          },
        ]);
        return payload;
      }

      try {
        console.log('[COORDINATOR_FINAL_PUBLISH_INPUT]', finalPublishInputLog);
        console.log('[COORDINATOR_PUBLISH_DEBUG] Snapshot presence before publish:', snapshotPresence);
        if (missingAcsms.length) {
          console.warn('[COORDINATOR_PUBLISH_DEBUG] Missing/partial ACSM snapshots:', missingAcsms);
        }
        console.log('[COORDINATOR_PUBLISH_DEBUG] Final payload summary:', debugSummary);
        console.log('[COORDINATOR_PUBLISH_DEBUG] Destination topic:', SUPPLY_CHAIN_REASONING_TOPIC);
        console.log(finalPublishLog);

        client.publish(SUPPLY_CHAIN_REASONING_TOPIC, JSON.stringify(payload), {
          qos: 0,
          retain: false,
        });

        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[SUPPLYCHAIN_PUBLISH] Sent to ${SUPPLY_CHAIN_REASONING_TOPIC}`,
          },
        ]);
        return payload;
      } catch (err) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[SUPPLYCHAIN_PUBLISH_ERROR] ${err?.message || err}`,
          },
        ]);
        return false;
      }
    },
    [acsmConfig.id, buildLevel3KnowledgePackage, level3AutoPublishEnabled]
  );

  const openCoordinatorDashboard = useCallback(() => {
    if (typeof window === 'undefined') return false;
    window.open('/analytics-system', '_blank', 'noopener,noreferrer');
    return true;
  }, []);

  const publishLevel3Outputs = useCallback(
    async (aggregate) => {
      if (!mqttClient || !aggregate?.complete) return false;

      try {
        const outputSet = buildLevel3OutputSet({
          aggregate,
          generatedAt: new Date().toISOString(),
        });

        return await level3PublisherRef.current.publishGlobalOutputs(mqttClient, outputSet);
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[LEVEL3_ERROR] ${error?.message || error}`,
          },
        ]);
        return false;
      }
    },
    [mqttClient]
  );

  const publishSupplyChainOutputs = useCallback(
    async (outputSet) => {
      if (String(acsmConfig.id || '').toLowerCase() !== 'acsm1') return false;
      if (!mqttClient || !outputSet) return false;

      try {
        return await supplyChainPublisherRef.current.publishOutputs(mqttClient, outputSet);
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[SUPPLYCHAIN_ERROR] ${error?.message || error}`,
          },
        ]);
        return false;
      }
    },
    [acsmConfig.id, mqttClient]
  );

  const syncHcmFromCoordinatorOutputs = useCallback(async (coordinatorOutputs) => {
    if (!coordinatorOutputs?.decision) {
      console.warn('[HCM SYNC] stop: coordinator output has no decision', coordinatorOutputs);
      return null;
    }

    const decision = coordinatorOutputs.decision || {};
    const optimizer = decision.corporateOptimizer || {};
    const diagnosis = optimizer.corporateDiagnosis || {};
    const goalRecommendation = decision.goalDrivenRecommendation || optimizer.goalDrivenRecommendation || {};
    const performanceGap = optimizer.performanceGap || {};
    const targets = optimizer.targets || {};
    const criticalACSM =
      goalRecommendation.targetACSM ||
      diagnosis.criticalACSM ||
      coordinatorOutputs.input?.reasonedKnowledge?.mostCriticalAcsm ||
      decision.receivedFrom ||
      'global';
    const targetACSM = String(criticalACSM || 'global').toLowerCase();
    const recommendation =
      decision.coordinationMessage ||
      decision.recommendation ||
      goalRecommendation.reason ||
      goalRecommendation.recommendedStrategy ||
      '';
    const signature = createStableSignature({
      criticalACSM: targetACSM,
      strategy: decision.strategy || goalRecommendation.recommendedStrategy,
      recommendation,
      rationale:
        decision.rationale ||
        goalRecommendation.reason ||
        coordinatorOutputs.reasoning?.executiveInterpretation,
      expectedGain:
        decision.expectedGain ||
        goalRecommendation.expectedImpact?.expectedOeeGain,
      globalOEE: performanceGap.currentOEE ?? decision.globalOEE,
      targetOEE: targets.targetOEE ?? performanceGap.targetOEE,
      risk: decision.riskLevel || coordinatorOutputs.input?.predictiveKnowledge?.deliveryImpactRisk,
      bottleneck:
        diagnosis.criticalCPS ||
        coordinatorOutputs.input?.reasonedKnowledge?.bottleneckCps ||
        decision.criticalCPS,
    });
    if (!signature) {
      console.warn('[HCM SYNC] stop: empty decision signature');
      return null;
    }
    if (lastHcmCoordinatorSignatureRef.current === signature) {
      console.log('[HCM SYNC] stop: duplicate decision signature', signature);
      return null;
    }

    try {
      const openPayload = {
        criticalACSM: targetACSM,
        globalOEE: performanceGap.currentOEE ?? decision.globalOEE,
        targetOEE: targets.targetOEE ?? performanceGap.targetOEE,
        risk: decision.riskLevel || coordinatorOutputs.input?.predictiveKnowledge?.deliveryImpactRisk,
        recommendation,
        bottleneck:
          diagnosis.criticalCPS ||
          coordinatorOutputs.input?.reasonedKnowledge?.bottleneckCps ||
          decision.criticalCPS,
        corporateGoal: targets,
        contextSnapshot: coordinatorOutputs,
      };
      console.log('[HCM OPEN] client request', openPayload);
      const openResponse = await fetch(`${HCM_API_BASE}/episode/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(openPayload),
      });
      const opened = await openResponse.json().catch(() => null);
      console.log('[HCM OPEN] client response', {
        ok: openResponse.ok,
        status: openResponse.status,
        episodeId: opened?.episode?.episodeId,
        error: opened?.error,
        response: opened,
      });
      const episodeId = opened?.episode?.episodeId;
      if (!openResponse.ok || !episodeId) {
        console.warn('[HCM SYNC] stop: episode open failed or no episodeId', {
          status: openResponse.status,
          opened,
        });
        return null;
      }

      const participants = Array.isArray(coordinatorOutputs.input?.participants)
        ? coordinatorOutputs.input.participants
        : ['acsm1'];
      const acsmEvents = participants
        .map((source) => String(source || '').toLowerCase())
        .filter((source) => COORDINATOR_ACSM_IDS.includes(source))
        .map((source) => {
          const eventPayload = {
            episodeId,
            source,
            eventType: 'state_update',
            content: {
              input: coordinatorOutputs.input,
              state: coordinatorOutputs.state,
            },
          };
          console.log('[HCM EVENT] client request', eventPayload);
          return fetch(`${HCM_API_BASE}/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventPayload),
          });
        });

      const recommendationEventPayload = {
        episodeId,
        source: 'coordinator',
        eventType: 'recommendation',
        content: {
          recommendation,
          reasoning: coordinatorOutputs.reasoning,
          goalDrivenRecommendation: goalRecommendation,
        },
      };
      const decisionPayload = {
        episodeId,
        targetACSM,
        strategy: decision.strategy || goalRecommendation.recommendedStrategy,
        recommendation,
        rationale:
          decision.rationale ||
          goalRecommendation.reason ||
          coordinatorOutputs.reasoning?.executiveInterpretation,
        expectedGain:
          decision.expectedGain ||
          goalRecommendation.expectedImpact?.expectedOeeGain,
      };
      console.log('[HCM EVENT] client request', recommendationEventPayload);
      console.log('[HCM DECISION] client request', decisionPayload);

      const writeResponses = await Promise.all([
        ...acsmEvents,
        fetch(`${HCM_API_BASE}/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(recommendationEventPayload),
        }),
        fetch(`${HCM_API_BASE}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(decisionPayload),
        }),
      ]);
      const writeResults = await Promise.all(
        writeResponses.map(async (response) => ({
          ok: response.ok,
          status: response.status,
          body: await response.json().catch(() => null),
        }))
      );
      console.log('[HCM SYNC] write responses', writeResults);

      if (writeResults.some((result) => !result.ok)) {
        console.warn('[HCM SYNC] stop: event or decision write failed', writeResults);
        return null;
      }

      lastHcmCoordinatorSignatureRef.current = signature;
      console.log('[HCM SYNC] complete', { episodeId, signature });
      console.log(
        '[HCM EFFECTIVENESS] client not called by coordinator sync; waiting for explicit feedback/effectiveness payload',
        { episodeId }
      );
      return episodeId;
    } catch (error) {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[HCM_SYNC_ERROR] ${error?.message || error}`,
        },
      ]);
      return null;
    }
  }, []);

  const publishToCoordinator = useCallback(
    () => publishLevel3KnowledgePackage(acsmConfig.id),
    [acsmConfig.id, publishLevel3KnowledgePackage]
  );

  const publishLevel3LocalContribution = useCallback(
    async (localAnalytics) => {
      if (!mqttClient || !localAnalytics) return false;

      const localOee = toNumber(localAnalytics?.globalOEE?.oee ?? localAnalytics?.oee?.oee, null);
      const managedCpsIds = acsmConfig.managedCpsIds || [];
      const eligibleCPS = playPhaseCPSRef.current;
      if (!Number.isFinite(localOee) || !eligibleCPS.length) {
        return false;
      }

      try {
        const payload = buildLevel3LocalContribution({
          acsmId: ACTIVE_ACSM.id,
          industryId: acsmConfig.industryId,
          industryName: acsmConfig.industryName,
          systemAnalytics: localAnalytics,
          addedCPS: eligibleCPS,
          managedCps: managedCpsIds,
          generatedAt: new Date().toISOString(),
        });

        return await level3PublisherRef.current.publishLocalContribution(mqttClient, payload);
      } catch (error) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[LEVEL3_INPUT_ERROR] ${error?.message || error}`,
          },
        ]);
        return false;
      }
    },
    [acsmConfig.industryId, acsmConfig.industryName, acsmConfig.managedCpsIds, mqttClient]
  );

  const patchRegistryCps = useCallback((cpsRef, patch) => {
    if (!cpsRef) return;

    const keys = [
      cpsRef.nome,
      cpsRef.id,
      cpsRef.topic,
      cpsRef.lifecycle?.cpsName,
      cpsRef.lifecycle?.cpsId,
      cpsRef.lifecycle?.baseTopic,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());

    setRegistry((prev) => {
      const next = { ...prev };

      const baseObj =
        next[String(cpsRef.nome || '').toLowerCase()] ||
        next[String(cpsRef.id || '').toLowerCase()] ||
        next[String(cpsRef.topic || '').toLowerCase()] ||
        cpsRef;

      const isCpsLai1 = isPhysicalCps(baseObj || cpsRef);
      const canonicalPhase = isCpsLai1 ? cpsLai1CanonicalLifecycleRef.current : null;
      const requestedPhase = getCpsLifecyclePhase(patch) || getCpsLifecyclePhase(baseObj);
      const protectedPhase =
        canonicalPhase && !canTransitionCpsLai1Lifecycle(canonicalPhase, requestedPhase)
          ? canonicalPhase
          : requestedPhase;
      const protectedPatch =
        isCpsLai1 && protectedPhase
          ? {
              ...patch,
              lifecyclePhase: protectedPhase,
              lifecycle: lifecycleWithPhase(
                { ...baseObj, lifecycle: { ...(baseObj.lifecycle || {}), ...(patch?.lifecycle || {}) } },
                protectedPhase
              ),
            }
          : patch;

      const updated = {
        ...baseObj,
        ...protectedPatch,
        lifecycle: {
          ...(baseObj.lifecycle || {}),
          ...(protectedPatch?.lifecycle || {}),
        },
        maintenance: {
          ...(baseObj.maintenance || {}),
          ...(protectedPatch?.maintenance || {}),
        },
        updates: {
          ...(baseObj.updates || {}),
          ...(protectedPatch?.updates || {}),
          history: Array.isArray(protectedPatch?.updates?.history)
            ? protectedPatch.updates.history
            : baseObj.updates?.history || [],
        },
        globalState: {
          ...(baseObj.globalState || {}),
          ...(protectedPatch?.globalState || {}),
        },
        health: {
          ...(baseObj.health || {}),
          ...(protectedPatch?.health || {}),
        },
        oee: {
          ...(baseObj.oee || {}),
          ...(protectedPatch?.oee || {}),
        },
        operationalData: {
          ...(baseObj.operationalData || {}),
          ...(protectedPatch?.operationalData || {}),
        },
        endpoints: {
          ...(baseObj.endpoints || {}),
          ...(protectedPatch?.endpoints || {}),
        },
        documents: {
          ...(baseObj.documents || {}),
          ...(protectedPatch?.documents || {}),
        },
        governanceProfile:
          protectedPatch?.governanceProfile !== undefined
            ? protectedPatch.governanceProfile
            : baseObj.governanceProfile || null,
        governanceStatus:
          protectedPatch?.governanceStatus ||
          protectedPatch?.governanceProfile?.status ||
          baseObj.governanceStatus ||
          baseObj.governanceProfile?.status ||
          GOVERNANCE_STATUS.NOT_DEFINED,
      };

      keys.forEach((k) => {
        next[k] = updated;
      });

      return next;
    });
  }, []);

  const appendRegistryHistory = useCallback((cpsRef, entry) => {
    if (!cpsRef || !entry) return;

    const keys = [
      cpsRef.nome,
      cpsRef.id,
      cpsRef.topic,
      cpsRef.lifecycle?.cpsName,
      cpsRef.lifecycle?.cpsId,
      cpsRef.lifecycle?.baseTopic,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());

    setRegistry((prev) => {
      const next = { ...prev };

      const baseObj =
        next[String(cpsRef.nome || '').toLowerCase()] ||
        next[String(cpsRef.id || '').toLowerCase()] ||
        next[String(cpsRef.topic || '').toLowerCase()] ||
        cpsRef;

      const oldHistory = Array.isArray(baseObj?.updates?.history) ? baseObj.updates.history : [];

      const alreadyExists = oldHistory.some(
        (item) => item?.id && entry?.id && String(item.id) === String(entry.id)
      );

      const newHistory = alreadyExists ? oldHistory : [entry, ...oldHistory].slice(0, 20);

      const updated = {
        ...baseObj,
        updates: {
          ...(baseObj.updates || {}),
          lastMessage: entry.message || baseObj?.updates?.lastMessage || null,
          lastType: entry.type || baseObj?.updates?.lastType || null,
          lastTs: entry.ts || baseObj?.updates?.lastTs || null,
          history: newHistory,
        },
      };

      keys.forEach((k) => {
        next[k] = updated;
      });

      return next;
    });
  }, []);

  const recordMaintenanceEntered = useCallback(
    (cpsRef, payload = {}, previousState = null) => {
      if (!cpsRef?.id) return false;

      const previousCanonical = canonicalOperationMode(
        previousState ??
          cpsRef?.operationalState ??
          cpsRef?.globalState?.state ??
          cpsRef?.operationalData?.operationMode
      );

      if (previousCanonical === 'maintenance' || cpsRef?.maintenance?.inProgress === true) {
        return false;
      }

      const ts = normalizeSnapshotTimestamp(payload?.ts ?? payload?.timestamp) ?? Date.now();
      const entry = {
        id: `${cpsRef.id}-maintenance-entered-${ts}`,
        type: 'MAINTENANCE_ENTERED',
        title: 'Maintenance entered',
        message: payload?.summary || 'CPS entered Maintenance from lifecycle transition.',
        ts,
        previousPhase: previousCanonical || getCpsLifecyclePhase(cpsRef) || null,
        currentPhase: 'maintenance',
      };

      appendRegistryHistory(cpsRef, entry);
      persistPlugEvent({
        id: entry.id,
        eventType: 'MAINTENANCE_ENTERED',
        cpsId: cpsRef.id,
        cpsName: cpsRef.nome,
        topic: cpsRef.topic,
        message: entry.message,
        details: {
          previousPhase: entry.previousPhase,
          currentPhase: entry.currentPhase,
          reason: payload?.reason || null,
          source: payload?.source || ACTIVE_ACSM.code,
        },
        ts,
      });
      pushSystemEvent({
        ts,
        type: 'MAINTENANCE_ENTERED',
        cpsId: cpsRef.id,
        cpsName: cpsRef.nome,
        message: entry.message,
      });
      return true;
    },
    [appendRegistryHistory, persistPlugEvent, pushSystemEvent]
  );

  const handleAnalyticsMessage = useCallback((topic, rawPayload) => {
    try {
      const parsed =
        rawPayload && typeof rawPayload === 'object' && !ArrayBuffer.isView(rawPayload)
          ? rawPayload
          : typeof rawPayload === 'string'
            ? JSON.parse(rawPayload)
            : JSON.parse(rawPayload.toString());

      if (isLevel2IntelligenceTopic(topic)) {
        const normalizedInput = normalizeLevel2AcsmIntelligence(parsed, topic);
        const source = normalizedInput.source;
        const patch = buildCoordinatorSnapshotPatch({
          acsmId: source,
          topic,
          payload: normalizedInput,
        });

        console.log('[COORDINATOR_REMOTE_INPUT]', {
          topic,
          source,
          messageType: normalizedInput?.messageType || parsed?.messageType || null,
          hasPayload: Boolean(parsed),
        });

        if (['acsm1', 'acsm2', 'acsm3'].includes(source)) {
          console.log('[COORDINATOR_REMOTE_PATCH]', {
            acsmId: source,
            patch,
          });

          mergeCoordinatorSnapshotState(source, patch);

          setMultiAcsmInputs((prev) => {
            const next = {
              ...prev,
              [source]: normalizedInput,
            };
            knowledgeStoreRef.current.multiAcsmInputs = next;
            return next;
          });

          setLog((prev) => [
            ...prev,
            {
              time: new Date().toLocaleTimeString(),
              message: `[LEVEL2_INPUT] ${source} -> ${topic}`,
            },
          ]);
        }

        return;
      }

      if (LEVEL3_INPUT_TOPICS.includes(topic)) {
        const contribution = level3ServiceRef.current.ingest(parsed, topic, Date.now());
        const aggregate = level3ServiceRef.current.evaluate(Date.now());

        setLevel3RuntimeStatus({
          level3Mode: aggregate?.level3Mode || 'partial',
          activeParticipantsCount: aggregate?.activeParticipantsCount ?? 0,
          expectedParticipantsCount: aggregate?.expectedParticipantsCount ?? 3,
          managedCpsCount: aggregate?.managedCpsCount ?? 0,
          managedCpsIds: aggregate?.managedCpsIds || [],
          presentAcsms: aggregate?.presentAcsms || [],
          missingAcsms: aggregate?.missingAcsms || [],
        });

        if (contribution) {
          mergeCoordinatorSnapshotState(
            contribution.acsmId,
            buildCoordinatorSnapshotPatch({
              acsmId: contribution.acsmId,
              topic,
              payload: {
                ...contribution,
                systemAnalytics: contribution.systemAnalytics || parsed.systemAnalytics || parsed,
              },
            })
          );

          setLog((prev) => [
            ...prev,
            {
              time: new Date().toLocaleTimeString(),
              message: `[LEVEL3_INPUT] ${contribution.acsmId} -> ${topic}`,
            },
          ]);
        }

        publishLevel3Outputs(aggregate);
        return;
      }

      const coordinatorAcsmId = getCoordinatorAcsmIdFromTopic(topic);
      const isCoordinatorSnapshotTopic =
        coordinatorAcsmId &&
        (topic === `${coordinatorAcsmId}/global/oee` ||
          topic === `${coordinatorAcsmId}/global/reasoning` ||
          topic === `${coordinatorAcsmId}/global/learning` ||
          topic === `${coordinatorAcsmId}/knowledge/global`);

      if (isCoordinatorSnapshotTopic) {
        mergeCoordinatorSnapshotState(
          coordinatorAcsmId,
          buildCoordinatorSnapshotPatch({
            acsmId: coordinatorAcsmId,
            topic,
            payload: parsed,
          })
        );

        if (coordinatorAcsmId !== 'acsm1') {
          setLog((prev) => [
            ...prev,
            {
              time: new Date().toLocaleTimeString(),
              message: `[COORDINATOR_SNAPSHOT] ${coordinatorAcsmId} -> ${topic}`,
            },
          ]);
          return;
        }
      }

      if (
        topic === ACSM_TOPICS.chainGlobalState ||
        topic === ACSM_TOPICS.chainGlobalReasoning ||
        topic === ACSM_TOPICS.chainGlobalLearning ||
        topic === ACSM_TOPICS.chainCoordinatorOutput ||
        topic === ACSM_TOPICS.chainKnowledgeGlobal ||
        topic === ACSM_TOPICS.chainKnowledgeExecutive ||
        topic === ACSM_TOPICS.supplyChainReasoning
      ) {
        if (topic === ACSM_TOPICS.supplyChainReasoning) {
          console.log('MQTT RECEIVED:', topic, parsed);
        }

        supplyChainCoordinatorRef.current.ingest(topic, parsed);
        const coordinatorOutputs = supplyChainCoordinatorRef.current.evaluate();

        if (coordinatorOutputs) {
          knowledgeStoreRef.current.supplychain = coordinatorOutputs;
          setSupplyChainCoordinator(coordinatorOutputs);
          syncHcmFromCoordinatorOutputs(coordinatorOutputs);
          if (topic !== ACSM_TOPICS.supplyChainReasoning) {
            publishSupplyChainOutputs(coordinatorOutputs);
          }
        }
      }

      if (
        topic === ACSM_TOPICS.globalOee ||
        topic === ACSM_TOPICS.globalReasoning ||
        topic === ACSM_TOPICS.globalLearning ||
        topic === ACSM_TOPICS.chainGlobalState ||
        topic === ACSM_TOPICS.chainGlobalReasoning ||
        topic === ACSM_TOPICS.chainGlobalLearning ||
        topic === ACSM_TOPICS.chainCoordinatorOutput
      ) {
        const isStateTopic =
          topic === ACSM_TOPICS.globalOee ||
          topic === ACSM_TOPICS.chainGlobalState ||
          topic === ACSM_TOPICS.chainCoordinatorOutput;
        const isReasoningTopic =
          topic === ACSM_TOPICS.globalReasoning || topic === ACSM_TOPICS.chainGlobalReasoning;
        const isLearningTopic =
          topic === ACSM_TOPICS.globalLearning || topic === ACSM_TOPICS.chainGlobalLearning;
        const raw = parsed?.payload || parsed || {};
        const reasoningPayload =
          raw?.reasoning && isPlainObject(raw.reasoning)
            ? raw.reasoning
            : isReasoningTopic && isPlainObject(raw)
              ? raw
              : undefined;
        const learningPayload =
          raw?.learning && isPlainObject(raw.learning)
            ? raw.learning
            : isLearningTopic && isPlainObject(raw)
              ? raw
              : undefined;
        const globalOeeSource =
          raw?.globalOEE && typeof raw.globalOEE === 'object'
            ? raw.globalOEE
            : raw?.oee && typeof raw.oee === 'object'
              ? raw.oee
              : {
                  oee: toNumber(raw?.globalOEE ?? raw?.oeeGlobal ?? raw?.oeeGlobalSeries, null),
                  current: toNumber(raw?.globalOEE ?? raw?.oeeGlobal ?? raw?.oeeGlobalSeries, null),
                  average: toNumber(raw?.oeeGlobalAverage, null),
                };

        const criticality = Array.isArray(raw?.criticality)
          ? raw.criticality
          : Array.isArray(raw?.criticalityRanking)
            ? raw.criticalityRanking
            : [];

        const dominantLosses = Array.isArray(raw?.dominantLosses)
          ? raw.dominantLosses
          : criticality.map((item) => ({
              cpsId: item?.cpsId,
              cpsName: item?.cpsName,
              dominantDimension: item?.dominantLoss || 'unknown',
              availabilityLoss: item?.criticalityDetails?.availabilityLoss ?? null,
              performanceLoss: item?.criticalityDetails?.performanceLoss ?? null,
              qualityLoss: item?.criticalityDetails?.qualityLoss ?? null,
            }));

      

        const normalized = normalizeSystemAnalytics({
          ...raw,
          generatedAt: raw?.generatedAt || raw?.isoDate || null,
          timestamp: raw?.timestamp || raw?.ts || null,
          globalOEE: globalOeeSource,
          oee: globalOeeSource,
          criticalCPS:
            raw?.criticalCoordinationPoint?.criticalCPS ||
            raw?.criticalCPS ||
            (raw?.criticalCps ? { cpsId: raw.criticalCps } : null),
          criticalCps:
            raw?.criticalCoordinationPoint?.criticalCPS ||
            raw?.criticalCps ||
            raw?.criticalCPS?.cpsId ||
            null,
          bottleneck:
            typeof raw?.bottleneck === 'string'
              ? { cpsId: raw.bottleneck }
              : raw?.bottleneck ||
                (raw?.criticalCoordinationPoint?.bottleneck
                  ? { cpsId: raw.criticalCoordinationPoint.bottleneck }
                  : null),
          criticality,
          criticalityRanking: criticality,
          dominantLosses,
          learnedPattern:
            raw?.learnedPattern ||
            raw?.patternLearned ||
            raw?.systemPattern ||
            raw?.derivedLearning?.pattern ||
            '-',
          patternLearned:
            raw?.patternLearned || raw?.learnedPattern || raw?.systemPattern || '-',
          systemPattern:
            raw?.systemPattern || raw?.patternLearned || raw?.learnedPattern || '-',
          riskLevel:
            raw?.riskLevel || raw?.riskSummary?.level || raw?.predictedRisk?.level || 'low',
          confidence: toNumber(
            raw?.confidence ??
              raw?.riskSummary?.confidence ??
              raw?.predictedRisk?.confidence ??
              raw?.derivedLearning?.confidence,
            0
          ),
          predictedGlobalOEE: toNumber(raw?.predictedGlobalOEE ?? raw?.predictedOeeGlobal, null),
          predictedOeeGlobal: toNumber(raw?.predictedOeeGlobal ?? raw?.predictedGlobalOEE, null),
          recommendation: raw?.recommendation || raw?.actionPlan?.recommendation || null,
          explanation: raw?.explanation || null,
          globalSummary: raw?.globalSummary || {},
          reasoning: reasoningPayload || {},
          learning: learningPayload || {},
          synchronization: raw?.synchronization || {},
          lossPropagation: raw?.lossPropagation || {},
          bottleneckMigration: raw?.bottleneckMigration || {},
          systemEvidence: raw?.systemEvidence || {},
          crossCpsPatterns: Array.isArray(raw?.crossCpsPatterns) ? raw.crossCpsPatterns : [],
          riskSummary: raw?.riskSummary || {},
          recommendedFocus: raw?.recommendedFocus || null,
          actionPlan: raw?.actionPlan || {},
          systemState: raw?.systemState || {},
          coordinationMode: raw?.coordinationMode || raw?.systemState?.coordinationMode || null,
          learningConsensus:
            raw?.learningConsensus || raw?.derivedLearning?.learningConsensus || null,
          fleetAnomalyIndex: toNumber(raw?.fleetAnomalyIndex, null),
          fleetDriftIndex: toNumber(raw?.fleetDriftIndex, null),
          stabilityIndex: toNumber(raw?.stabilityIndex, null),
          riskDrivers: Array.isArray(raw?.riskDrivers) ? raw.riskDrivers : [],
          supportingSignals: Array.isArray(raw?.supportingSignals) ? raw.supportingSignals : [],
          derivedLearning: raw?.derivedLearning || {},
          predictedRisk: raw?.predictedRisk || {},
          historySummary: raw?.historySummary || {},
          level3Mode: raw?.level3Mode || raw?.globalSummary?.level3Mode || null,
          activeParticipantsCount: toNumber(
            raw?.activeParticipantsCount ?? raw?.globalSummary?.activeParticipantsCount,
            null
          ),
          expectedParticipantsCount: toNumber(
            raw?.expectedParticipantsCount ?? raw?.globalSummary?.expectedParticipantsCount,
            null
          ),
          managedCpsCount: toNumber(
            raw?.managedCpsCount ??
              raw?.globalSummary?.managedCpsCount ??
              raw?.plantKnowledge?.managedCpsCount,
            null
          ),
          managedCpsIds:
            raw?.managedCpsIds ||
            raw?.globalSummary?.managedCpsIds ||
            raw?.plantKnowledge?.managedCpsIds ||
            [],
          coordinatorOutput:
            topic === ACSM_TOPICS.chainCoordinatorOutput
              ? raw
              : {
                  ...(raw?.coordinatorOutput || {}),
                  globalOEE: toNumber(raw?.globalOEE?.oee ?? raw?.globalOEE ?? raw?.oeeGlobal, null),
                  recommendation: raw?.recommendation || raw?.coordinatorOutput?.recommendation || null,
                  explanation: raw?.explanation || raw?.coordinatorOutput?.explanation || null,
                },
        });

        setSystemAnalytics((prev) => {
          if (!isStateTopic) {
            return {
              ...prev,
              generatedAt: normalized.generatedAt ?? prev.generatedAt ?? null,
              timestamp: normalized.timestamp ?? prev.timestamp ?? null,
              ts: normalized.ts ?? prev.ts ?? null,
              globalSummary: mergeDefinedDeep(prev.globalSummary || {}, normalized.globalSummary),
              reasoning: mergeDefinedDeep(prev.reasoning || {}, normalized.reasoning),
              learning: mergeDefinedDeep(prev.learning || {}, normalized.learning),
            };
          }

          return {
            ...prev,
            ...normalized,
            systemEvidence: hasKeys(normalized.systemEvidence)
              ? normalized.systemEvidence
              : prev.systemEvidence || {},
            actionPlan: hasKeys(normalized.actionPlan)
              ? normalized.actionPlan
              : prev.actionPlan || {},
            systemState: hasKeys(normalized.systemState)
              ? normalized.systemState
              : prev.systemState || {},
            supportingSignals: normalized.supportingSignals || [],
            riskDrivers: normalized.riskDrivers || [],
            crossCpsPatterns: normalized.crossCpsPatterns || [],
            riskSummary: hasKeys(normalized.riskSummary)
              ? normalized.riskSummary
              : prev.riskSummary || {},
            recommendedFocus: normalized.recommendedFocus ?? prev.recommendedFocus ?? null,
            coordinationMode: normalized.coordinationMode ?? prev.coordinationMode ?? null,
            learningConsensus: normalized.learningConsensus ?? prev.learningConsensus ?? null,
            fleetAnomalyIndex: normalized.fleetAnomalyIndex ?? prev.fleetAnomalyIndex ?? null,
            fleetDriftIndex: normalized.fleetDriftIndex ?? prev.fleetDriftIndex ?? null,
            stabilityIndex: normalized.stabilityIndex ?? prev.stabilityIndex ?? null,
            derivedLearning: hasKeys(normalized.derivedLearning)
              ? normalized.derivedLearning
              : prev.derivedLearning || {},
            predictedRisk: hasKeys(normalized.predictedRisk)
              ? normalized.predictedRisk
              : prev.predictedRisk || {},
            historySummary: hasKeys(normalized.historySummary)
              ? normalized.historySummary
              : prev.historySummary || {},
            globalSummary: mergeDefinedDeep(prev.globalSummary || {}, normalized.globalSummary),
            reasoning: mergeDefinedDeep(prev.reasoning || {}, normalized.reasoning),
            learning: mergeDefinedDeep(prev.learning || {}, normalized.learning),
          };
        });

        setLevel3RuntimeStatus((prev) => ({
          ...prev,
          level3Mode: normalized?.level3Mode || prev.level3Mode || 'partial',
          activeParticipantsCount:
            normalized?.activeParticipantsCount ?? prev.activeParticipantsCount ?? 0,
          expectedParticipantsCount:
            normalized?.expectedParticipantsCount ?? prev.expectedParticipantsCount ?? 3,
          managedCpsCount: normalized?.managedCpsCount ?? prev.managedCpsCount ?? 0,
          managedCpsIds: normalized?.managedCpsIds || prev.managedCpsIds || [],
          presentAcsms: raw?.presentAcsms || prev.presentAcsms || [],
          missingAcsms: raw?.missingAcsms || prev.missingAcsms || [],
        }));

        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[GLOBAL_ANALYTICS] Updated from topic=${topic}`,
          },
        ]);

        return;
      }

      if (isAiEnrichedAnalyticsTopic(topic)) {
        const data =
          parsed && typeof parsed === 'object'
            ? parsed
            : safeParseJson(rawPayload);

        if (!data) {
          console.warn('[AI ENRICHED RECEIVED] Unable to parse payload', {
            topic,
            rawPayload: rawPayload?.slice?.(0, 500) || rawPayload,
          });
          return;
        }

        const enrichedCpsId =
          normalizeCpsId(data?.cpsId) ||
          getAiEnrichedAnalyticsCpsIdFromTopic(topic);

        if (!enrichedCpsId) {
          console.warn('[AI ENRICHED RECEIVED] Unable to resolve cpsId', {
            topic,
            payloadCpsId: data?.cpsId,
          });
          return;
        }

        const enrichedOwner = withRememberedOperationMode(
          addedCPSRef.current.find((c) => c.id === enrichedCpsId) ||
            Object.values(registryRef.current || {}).find((c) => c?.id === enrichedCpsId)
        );

        if (!canIngestCognitivePayload(enrichedOwner)) return;

        console.log('[AI ENRICHED RECEIVED]', {
          topic,
          cpsId: enrichedCpsId,
          analysisMode: data?.analysisMode || 'light',
          analysisSource: data?.analysisSource || 'live',
          aiLastUpdate: data?.timestamp || data?.ts || null,
          hasEnrichedAnalysis: Boolean(data?.enrichedAnalysis || data?.ai || data?.analysis || data?.summary),
        });

        setCpsAnalyticsState((prev) => {
          const nextEntry = buildAiEnrichedAnalyticsEntry(
            prev?.[enrichedCpsId] || {},
            enrichedCpsId,
            data
          );
          console.log('[AI ENRICHED STATE KEY]', {
            cpsId: enrichedCpsId,
            analysisMode: nextEntry.analysisMode,
            analysisSource: nextEntry.analysisSource,
            previousAiLastUpdate: prev?.[enrichedCpsId]?.aiLastUpdate || null,
            aiLastUpdate: nextEntry.aiLastUpdate,
          });

          return {
            ...prev,
            [enrichedCpsId]: nextEntry,
          };
        });
        return;
      }

      const topicBase = normalizeTopic(topic).split('/')[0] || '';
      const rawCpsId = parsed?.cpsId || parsed?.baseTopic || topicBase || 'UNKNOWN';
      const cpsId = String(rawCpsId)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/(cps)0+/, '$1');

      if (cpsId === 'unknown') return;

      const owner = withRememberedOperationMode(
        addedCPSRef.current.find((c) => normalizeCpsId(c?.id) === cpsId) ||
          Object.values(registryRef.current || {}).find((c) => normalizeCpsId(c?.id) === cpsId)
      );
      const ownerInPlay = isCpsInPlay(owner);
      const explicitAnalyticsOperationMode = getExplicitOperationMode(parsed);
      const runtimeAnalyticsOperationMode =
        !isPhysicalCps(owner) && isRuntimeOperationMode(explicitAnalyticsOperationMode)
        ? canonicalOperationMode(explicitAnalyticsOperationMode)
        : null;
      const ownerForOperationalCheck =
        runtimeAnalyticsOperationMode !== null
          ? {
              ...owner,
              operationalData: operationalDataWithMode(owner, runtimeAnalyticsOperationMode),
            }
          : owner;
      const ownerCanIngestCognitivePayload = canIngestCognitivePayload(ownerForOperationalCheck);
      const patchExplicitOperationModeOnly = () => {
        if (!owner || runtimeAnalyticsOperationMode === null) return;
        rememberOperationMode(owner, runtimeAnalyticsOperationMode);
        const nextOperationalData = operationalDataWithMode(owner, runtimeAnalyticsOperationMode);
        setAddedCPS((prev) =>
          prev.map((c) => (c.id === owner.id ? { ...c, operationalData: nextOperationalData } : c))
        );
        patchRegistryCps(owner, { operationalData: nextOperationalData });
      };

      if (topic.endsWith('/oee')) {
        const normalized = normalizeLocalAnalyticsPayload(parsed, topic);

        if (!normalized?.cpsId) return;

        const currentAnalytics = cpsAnalyticsRef.current?.[normalized.cpsId] || {};
        const currentOeeTimestamp = owner?.oee?.lastUpdate || currentAnalytics?.lastUpdate;
        if (!isNewerSnapshot(parsed?.ts ?? parsed?.timestamp, currentOeeTimestamp)) return;

        if (!ownerCanIngestCognitivePayload) {
          patchExplicitOperationModeOnly();
          return;
        }

        updateKnowledgeStoreFromAnalytics(normalized.cpsId, {
          ...normalized,
          ts: normalized?.ts ?? Date.now(),
        });

        setCpsAnalyticsState((prev) => ({
          ...prev,
          [normalized.cpsId]: mergeCpsAnalyticsEntry(prev?.[normalized.cpsId] || {}, {
            ...normalized,
            oee: canonicalizeOeeBlock({
              ...(prev?.[normalized.cpsId]?.oee || {}),
              ...(normalized?.oee || {}),
            }),
          }),
        }));

        if (owner) {
          const isCpsLai1Owner = normalizeCpsId(owner?.id) === 'cpslai1';
          const isCpsLai3Owner = normalizeCpsId(owner?.id) === 'cpslai3';
          const hasExplicitCpsLai3CalculationState =
            isCpsLai3Owner && Object.prototype.hasOwnProperty.call(normalized, 'calculationState');
          const oeeNotComputed =
            String(normalized?.sourceStatus || normalized?.oee?.status || '').toUpperCase() ===
              'NOT_COMPUTED' && !hasExplicitCpsLai3CalculationState;
          const productionPatch =
            isCpsLai1Owner &&
            Object.prototype.hasOwnProperty.call(normalized, 'production')
              ? { production: normalized.production }
              : {};
          const nextOwnerOee = {
            availability: hasExplicitCpsLai3CalculationState
              ? normalized?.oee?.availability ?? null
              : oeeNotComputed
              ? null
              : isCpsLai1Owner
                ? normalized?.oee?.availability ?? null
                : normalized?.oee?.availability ?? owner?.oee?.availability ?? null,
            performance: hasExplicitCpsLai3CalculationState
              ? normalized?.oee?.performance ?? null
              : oeeNotComputed
              ? null
              : isCpsLai1Owner
                ? normalized?.oee?.performance ?? null
                : normalized?.oee?.performance ?? owner?.oee?.performance ?? null,
            quality: hasExplicitCpsLai3CalculationState
              ? normalized?.oee?.quality ?? null
              : oeeNotComputed
              ? null
              : isCpsLai1Owner
                ? normalized?.oee?.quality ?? null
                : normalized?.oee?.quality ?? owner?.oee?.quality ?? null,
            value: hasExplicitCpsLai3CalculationState
              ? normalized?.oee?.oee ?? normalized?.oee?.value ?? normalized?.oee?.current ?? null
              : oeeNotComputed
              ? null
              : isCpsLai1Owner
                ? normalized?.oee?.oee ?? normalized?.oee?.value ?? normalized?.oee?.current ?? null
                : normalized?.oee?.oee ??
                  normalized?.oee?.value ??
                  normalized?.oee?.current ??
                  owner?.oee?.value ??
                  null,
            totals: normalized?.totals ?? owner?.oee?.totals ?? null,
            sourceStatus: normalized?.sourceStatus ?? owner?.oee?.sourceStatus ?? null,
            calculationState: normalized?.calculationState ?? owner?.oee?.calculationState ?? null,
            evidenceStatus: normalized?.evidenceStatus ?? owner?.oee?.evidenceStatus ?? null,
            reason: normalized?.reason ?? owner?.oee?.reason ?? null,
            windowId: normalized?.windowId ?? owner?.oee?.windowId ?? null,
            lastUpdate: normalized?.ts ?? owner?.oee?.lastUpdate ?? Date.now(),
          };

          const operationalDataPatch = {
            pieceCounter:
              normalized?.telemetry?.pieceCounter ??
              owner?.operationalData?.pieceCounter ??
              null,
            cycleTimeMs:
              normalized?.telemetry?.cycleTimeMs ??
              owner?.operationalData?.cycleTimeMs ??
              null,
            currentTemperature:
              normalized?.telemetry?.temperature ??
              owner?.operationalData?.currentTemperature ??
              null,
            currentRPM:
              normalized?.telemetry?.rpm ??
              owner?.operationalData?.currentRPM ??
              null,
            currentTorque:
              normalized?.telemetry?.torque ??
              owner?.operationalData?.currentTorque ??
              null,
          };
          const nextOperationalData = {
            ...(owner?.operationalData || {}),
            ...operationalDataPatch,
            operationMode: owner?.operationalData?.operationMode ?? null,
          };

          setAddedCPS((prev) =>
            prev.map((c) =>
              c.id === owner.id
                ? {
                    ...c,
                    ...productionPatch,
                    oee: nextOwnerOee,
                    operationalData: isCpsLai1Owner
                      ? mergeNonStatusOperationalData(c, operationalDataPatch)
                      : nextOperationalData,
                  }
                : c
            )
          );

          patchRegistryCps(owner, {
            ...productionPatch,
            oee: nextOwnerOee,
            operationalData: isCpsLai1Owner ? operationalDataPatch : nextOperationalData,
          });

          setLog((prev) => [
            ...prev,
            {
              time: new Date().toLocaleTimeString(),
              message:
                `[OEE] ${owner.nome} -> ` +
                `A=${String(normalized?.oee?.availability ?? '-')} ` +
                `P=${String(normalized?.oee?.performance ?? '-')} ` +
                `Q=${String(normalized?.oee?.quality ?? '-')} ` +
                `OEE=${String(normalized?.oee?.oee ?? normalized?.oee?.value ?? normalized?.oee?.current ?? '-')}`,
            },
          ]);
        }

        const analytics = runSystemAnalytics();
        publishLevel3LocalContribution(analytics);
        return;
      }

      if (topic.endsWith('/learning')) {
        const normalized = normalizeLocalIntelligencePayload(parsed, topic);

        if (!normalized?.cpsId) return;

        const currentLearningTimestamp = cpsAnalyticsRef.current?.[normalized.cpsId]?.lastUpdate;
        if (!isNewerSnapshot(parsed?.ts ?? parsed?.timestamp, currentLearningTimestamp)) return;

        if (!ownerCanIngestCognitivePayload) {
          patchExplicitOperationModeOnly();
          return;
        }

        const existingAnalytics = cpsAnalyticsRef.current?.[normalized.cpsId] || {};
        const baselineEvidence = extractLocalBaselineEvidence(normalized);
        const operationalDataPatch = owner
          ? {
              pieceCounter:
                normalized?.totals?.totalCount ??
                normalized?.production?.totalPieces ??
                owner?.operationalData?.pieceCounter ??
                null,
              cycleTimeMs:
                normalized?.features?.avgCycleTimeMs ??
                normalized?.welding?.cycleTimeMs ??
                owner?.operationalData?.cycleTimeMs ??
                null,
              currentTemperature:
                normalized?.features?.avgTemperature ??
                normalized?.features?.avgTempPontaSolda ??
                normalized?.welding?.tipTemperature ??
                owner?.operationalData?.currentTemperature ??
                null,
              currentRPM:
                normalized?.features?.avgRpm ??
                normalized?.features?.avgCorrenteArco ??
                owner?.operationalData?.currentRPM ??
                null,
              currentTorque:
                normalized?.features?.avgTorque ??
                normalized?.features?.avgPressaoGas ??
                owner?.operationalData?.currentTorque ??
                null,
            }
          : null;
        const nextOperationalData = owner && operationalDataPatch
          ? {
              ...(owner?.operationalData || {}),
              ...operationalDataPatch,
              operationMode: owner?.operationalData?.operationMode ?? null,
            }
          : null;

        const nextAnalytics = mergeCpsAnalyticsEntry(existingAnalytics, {
          cpsId: normalized.cpsId,
          cpsName: normalized?.cpsName || existingAnalytics?.cpsName || normalized.cpsId,
          learning: normalized?.learning,
          reasoning: normalized?.reasoning,
          oee: canonicalizeOeeBlock(normalized?.oee),
          statistics: normalized?.statistics,
          features: normalized?.features,
          window: normalized?.window,
          totals: normalized?.totals,
          evidence: baselineEvidence,
          basis:
            baselineEvidence ||
            normalized?.basis ||
            normalized?.learning?.basis ||
            normalized?.learning?.Basis,
          timeSeriesFeatures: normalized?.timeSeriesFeatures,
          prediction: normalized?.prediction,
          recommendation: normalized?.recommendation,
          lastUpdate: normalized?.lastUpdate || new Date().toISOString(),
        });
        const knowledgeRegistrationPayload = {
          cpsId: normalized.cpsId,
          source: normalized?.reasoning ? 'reasoning' : normalized?.learning ? 'learning' : 'cps',
          timestamp: normalized?.timestamp || normalized?.lastUpdate || new Date().toISOString(),
          originalKnowledge: {
            learning: normalized?.learning || null,
            reasoning: normalized?.reasoning || null,
            evidence: baselineEvidence || normalized?.evidence || null,
            recommendation:
              normalized?.recommendation ||
              normalized?.reasoning?.recommendation ||
              normalized?.learning?.recommendation ||
              null,
            pattern:
              normalized?.learning?.pattern ||
              normalized?.learning?.learned ||
              normalized?.learningPattern ||
              null,
            dominantLoss:
              normalized?.reasoning?.dominantLoss ||
              normalized?.reasoning?.dominantLossNow ||
              null,
            probableCause: normalized?.reasoning?.probableCause || null,
            forecast: normalized?.forecast || normalized?.prediction || null,
            anomaly: normalized?.anomaly || null,
            drift: normalized?.learning?.driftScore ?? normalized?.driftScore ?? null,
            governableAction:
              normalized?.governableAction ||
              normalized?.reasoning?.governableAction ||
              normalized?.learning?.governableAction ||
              null,
            variation:
              normalized?.variation ??
              normalized?.reasoning?.variation ??
              normalized?.learning?.variation ??
              null,
            requestedValue:
              normalized?.requestedValue ??
              normalized?.reasoning?.requestedValue ??
              normalized?.learning?.requestedValue ??
              null,
            unit: normalized?.unit || normalized?.reasoning?.unit || normalized?.learning?.unit || null,
          },
        };
        const governableRecommendation = extractGovernableRecommendation({
          ...normalized,
          ...nextAnalytics,
          source: 'reasoning',
        });
        if (governableRecommendation) {
          (async () => {
            const episodeId = await openLocalCognitiveEpisodeForRecommendation({
              ...normalized,
              ...nextAnalytics,
              governableAction: governableRecommendation.action,
              action: governableRecommendation.action,
              variation: governableRecommendation.variation,
              requestedValue: governableRecommendation.requestedValue,
              unit: governableRecommendation.unit,
              recommendation: governableRecommendation.recommendation || normalized?.reasoning?.recommendation || normalized?.recommendation,
            });
            await registerHcmKnowledgeItem({
              ...knowledgeRegistrationPayload,
              episodeId,
            });
            checkGovernanceAction({
              cpsId: normalized.cpsId,
              action: governableRecommendation.action,
              variation: governableRecommendation.variation,
              requestedValue: governableRecommendation.requestedValue,
              unit: governableRecommendation.unit,
              source: governableRecommendation.source,
              recommendation: governableRecommendation.recommendation || normalized?.reasoning?.recommendation || normalized?.recommendation,
              episodeId,
              correlationId: episodeId,
            });
          })();
        } else {
          registerHcmKnowledgeItem(knowledgeRegistrationPayload);
        }

        setCpsAnalyticsState((prev) => {
          const merged = mergeCpsAnalyticsEntry(prev[normalized.cpsId] || {}, nextAnalytics);

          return {
            ...prev,
            [normalized.cpsId]: merged,
          };
        });

        if (owner && nextOperationalData) {
          setAddedCPS((prev) =>
            prev.map((c) =>
              c.id === owner.id
                ? {
                    ...c,
                    operationalData: isPhysicalCps(c)
                      ? mergeNonStatusOperationalData(c, operationalDataPatch)
                      : nextOperationalData,
                  }
                : c
            )
          );

          patchRegistryCps(owner, {
            operationalData: isPhysicalCps(owner) ? operationalDataPatch : nextOperationalData,
          });
        }

        updateKnowledgeStoreFromAnalytics(normalized.cpsId, {
          ...nextAnalytics,
          operationalData: nextOperationalData,
          ts: normalized?.ts || Date.now(),
        });

        const analytics = runSystemAnalytics();

        pushSystemEvent({
          ts: normalized?.ts || Date.now(),
          type: 'analytics_refresh',
          cpsId: normalized.cpsId,
          cpsName: normalized?.cpsName || normalized.cpsId,
          message: `System analytics recalculated after learning update from ${normalized.cpsId}`,
          payload: analytics?.coordinatorOutput || null,
        });

        publishLevel3LocalContribution(analytics);

        return;
      }
    } catch (err) {
      console.error('Erro ao processar mensagem analytics MQTT:', err);
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[ANALYTICS_ERROR] ${err?.message || err}`,
        },
      ]);
    }
  }, [
    mergeCoordinatorSnapshotState,
    patchRegistryCps,
    publishLevel3LocalContribution,
    publishLevel3Outputs,
    publishSupplyChainOutputs,
    syncHcmFromCoordinatorOutputs,
    pushSystemEvent,
    rememberOperationMode,
    runSystemAnalytics,
    checkGovernanceAction,
    openLocalCognitiveEpisodeForRecommendation,
    registerHcmKnowledgeItem,
    updateKnowledgeStoreFromAnalytics,
    withRememberedOperationMode,
  ]);

  const registerCPS = useCallback(
    async (parsed) => {
      try {
        const { cps: parsedCps } = parseAASCps(parsed);
        const normalizedCpsId = normalizeCpsId(parsedCps.id);
        const governanceProfile = await ensureGovernanceProfileForCps(parsedCps);
        const previousCps =
          Object.values(registryRef.current || {}).find(
            (item) => normalizeCpsId(item?.id) === normalizedCpsId
          ) || null;
        const lifecyclePhase = previousCps
          ? getCpsLifecyclePhase(previousCps) || 'registered'
          : 'registered';
        const cpsWithGovernance = {
          ...parsedCps,
          lifecyclePhase,
          lifecycle: {
            ...(parsedCps.lifecycle || {}),
            currentPhase: lifecyclePhase,
            phase: lifecyclePhase,
          },
          governanceProfile,
          governanceStatus: governanceProfile?.status || GOVERNANCE_STATUS.NOT_DEFINED,
        };
        const cps = cpsWithGovernance;

        setRegistry((prev) => ({
          ...prev,
          [String(cps.nome).toLowerCase()]: cps,
          [String(cps.id).toLowerCase()]: cps,
          [String(cps.topic).toLowerCase()]: cps,
          [String(cps.lifecycle?.cpsName).toLowerCase()]: cps,
          [String(cps.lifecycle?.cpsId).toLowerCase()]: cps,
          [String(cps.lifecycle?.baseTopic).toLowerCase()]: cps,
        }));
        setGovernanceProfiles((prev) => ({
          ...prev,
          [cps.id]: governanceProfile,
        }));
        if (!knowledgeStoreRef.current.cps[cps.id]) {
          knowledgeStoreRef.current.cps[cps.id] = {
            cpsId: cps.id,
            cpsName: cps.nome,
            baseTopic: cps.topic,
            history: [],
            reasoningDocs: [],
            learningDocs: [],
          };
        }

        persistPlugEvent({
          eventType: 'cps_registered',
          cpsId: cps.id,
          cpsName: cps.nome,
          topic: cps.topic,
          message: 'CPS registered in Plug Phase from AAS.',
          details: {
            server: cps.server,
            brokerPort: cps.brokerPort,
            brokerWs: cps.brokerWs,
            brokerWss: cps.brokerWss,
            dashboardUrl: cps.dashboardUrl,
            endpoints: cps.endpoints,
            lifecycle: cps.lifecycle,
            aasMetadata: cps.aasMetadata,
            operationalData: cps.operationalData,
            documents: cps.documents,
          },
          ts: Date.now(),
        });

        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message:
              `[REGISTER] ${cps.nome} registered ` +
              `(id=${cps.id}, topic=${cps.topic}, server=${cps.server}, ws=${cps.brokerWs}).`,
          },
          {
            time: new Date().toLocaleTimeString(),
            message:
              `[AAS] Endpoints -> description=${cps.endpoints.description || '-'} | ` +
              `summary=${cps.endpoints.summary || '-'} | indicators=${cps.endpoints.indicators || '-'} | ` +
              `history=${cps.endpoints.history || '-'} | health=${cps.endpoints.health || '-'}`,
          },
          {
            time: new Date().toLocaleTimeString(),
            message:
              `[FUNCTIONS_DEBUG] ${cps.nome} -> ${
                cps.funcionalidades?.map((f) => f.key).join(', ') || 'none'
              }`,
          },
          {
            time: new Date().toLocaleTimeString(),
            message:
              governanceProfile
              ? `[GOVERNANCE] ${cps.nome} profile ${governanceProfile.profileId} (${governanceProfile.status}); explicit Plug starts a new approval cycle.`
                : `[GOVERNANCE] ${cps.nome} registered without an active profile; explicit Plug is required.`,
          },
        ]);

        pushSystemEvent({
          ts: Date.now(),
          type: 'cps_registered',
          cpsId: cps.id,
          cpsName: cps.nome,
          message: `CPS ${cps.nome} registered in Plug Phase.`,
        });
        publishCpsLai1LifecyclePhase(cps, cps.lifecyclePhase);

        return true;
      } catch (err) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[REGISTER_ERROR] ${err?.message || err}`,
          },
        ]);
        return false;
      }
    },
    [
      ensureGovernanceProfileForCps,
      persistPlugEvent,
      publishCpsLai1LifecyclePhase,
      pushSystemEvent,
    ]
  );

  const plugCPS = useCallback(
    async (idOrName) => {
      const normalizedCpsId = normalizeCpsId(idOrName);
      const cps = Object.values(registryRef.current || {}).find(
        (item) => normalizeCpsId(item?.id) === normalizedCpsId ||
          String(item?.nome || '').toLowerCase() === String(idOrName || '').toLowerCase()
      );
      if (!cps?.id) return { ok: false, reason: 'CPS_NOT_REGISTERED' };

      const timestamp = new Date().toISOString();
      const plugEventId = `${normalizeCpsId(cps.id)}-plug-event-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const asset = {
        cps: { ...cps, cpsId: cps.id, lifecyclePhase: 'registered' },
        identification: {
          manufacturer: cps.manufacturer || null,
          assetType: cps.assetType || null,
          serialNumber: cps.serialNumber || null,
          description: cps.descricao || null,
        },
        aas: cps.aasMetadata || null,
        interfaces: {
          baseTopic: cps.topic || cps.id,
          brokerHost: cps.server || null,
          brokerPort: cps.brokerPort || null,
          endpoints: cps.endpoints || null,
        },
        supportedPhases: Array.isArray(cps.lifecycle?.supportedPhases)
          ? cps.lifecycle.supportedPhases
          : String(cps.lifecycle?.supportedPhases || '')
              .split(/[|,;/]+/)
              .map((phase) => phase.trim())
              .filter(Boolean),
      };

      try {
        const response = await fetch('/api/acsm/plug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            lifecycleTransition: { cpsId: cps.id, phase: 'plug', timestamp, plugEventId },
            asset,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result?.ok) {
          throw new Error(result?.error || result?.reason || `Plug failed (HTTP ${response.status}).`);
        }

        const [governanceResponse, plugResponse] = await Promise.all([
          fetch(`${GOVERNANCE_API_BASE}/cps/${encodeURIComponent(cps.id)}`, { cache: 'no-store' }),
          fetch('/api/acsm/plug', { cache: 'no-store' }),
        ]);
        const [governanceData, plugState] = await Promise.all([
          governanceResponse.json(),
          plugResponse.json(),
        ]);
        const activeProfile = governanceData?.activeProfile || governanceData?.profile || null;
        const snapshotProfile = plugState?.assets?.find((item) =>
          normalizeCpsId(item?.cps?.cpsId || item?.cps?.id) === normalizeCpsId(cps.id)
        )?.governance?.activeProfile;
        if (
          !governanceResponse.ok || !plugResponse.ok ||
          activeProfile?.profileId !== result.activeProfile?.profileId ||
          snapshotProfile?.profileId !== result.activeProfile?.profileId ||
          activeProfile?.status !== GOVERNANCE_STATUS.PENDING_APPROVAL ||
          snapshotProfile?.status !== GOVERNANCE_STATUS.PENDING_APPROVAL
        ) {
          throw new Error('Plug profile mismatch between action response, Governance API and Plug snapshot.');
        }

        applyGovernanceProfileToState(cps.id, activeProfile);
        patchRegistryCps(cps, {
          lifecyclePhase: 'plug',
          lifecycle: lifecycleWithPhase(cps, 'plug'),
          governanceProfile: activeProfile,
          governanceStatus: activeProfile.status,
        });
        publishCpsLai1LifecyclePhase(cps, 'plug');
        return { ok: true, cpsId: cps.id, lifecyclePhase: 'plug', activeProfile, state: plugState };
      } catch (error) {
        setLog((prev) => [...prev, {
          time: new Date().toLocaleTimeString(),
          message: `[PLUG_ERROR] ${cps.id}: ${error?.message || error}`,
        }]);
        return { ok: false, cpsId: cps.id, reason: error?.message || 'PLUG_FAILED' };
      }
    },
    [applyGovernanceProfileToState, patchRegistryCps, publishCpsLai1LifecyclePhase]
  );

  useEffect(() => {
    let cancelled = false;

    const loadCpsFromServer = async () => {
      try {
        const query = new URLSearchParams({ acsmId: acsmConfig.id }).toString();
        const res = await fetch(`/api/cps?${query}`, { cache: 'no-store' });
        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          throw new Error(`Failed to fetch /api/cps (${res.status}): ${errorBody || res.statusText}`);
        }
        const data = await res.json();
        const arr = Array.isArray(data.cps) ? data.cps : [];
        if (cancelled) return;

        const results = await Promise.allSettled(
          arr.map(async (parsed, index) => {
            const aas = Array.isArray(parsed?.assetAdministrationShells)
              ? parsed.assetAdministrationShells[0]
              : null;
            const rawId =
              getSpecificAssetIdValue(aas, 'cpsId') || aas?.idShort || `item-${index + 1}`;
            const normalizedId = normalizeCpsId(rawId);

            if (cancelled) return { rawId, normalizedId, cancelled: true };

            const registered = await registerCPS(parsed);
            if (!registered) {
              throw new Error(`Registration rejected for ${rawId} (${normalizedId || 'unknown'}).`);
            }

            return { rawId, normalizedId, registered: true };
          })
        );

        if (cancelled) return;

        const failures = results
          .map((result, index) => ({ result, index }))
          .filter(({ result }) => result.status === 'rejected')
          .map(({ result, index }) =>
            result.reason?.message || `CPS item ${index + 1} failed to register.`
          );

        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[PLUG_LOAD] Registered ${results.length - failures.length}/${results.length} CPS from /api/cps.`,
          },
          ...failures.map((message) => ({
            time: new Date().toLocaleTimeString(),
            message: `[PLUG_LOAD_ITEM_ERROR] ${message}`,
          })),
        ]);
      } catch (e) {
        if (cancelled) return;
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[PLUG_LOAD_ERROR] Failed to autoload CPS: ${e?.message || e}`,
          },
        ]);
      }
    };

    loadCpsFromServer();

    return () => {
      cancelled = true;
    };
  }, [acsmConfig.id, registerCPS]);

  const publishLifecycleCommand = useCallback(
    (cps, action) => {
      if (!mqttClient || !cps?.topic) return false;

      const cmdTopic = joinTopic(cps.topic, COMMAND_TOPIC_SUFFIX);

      const payload = {
        type: 'lifecycle_command',
        action,
        cpsId: cps.id,
        cpsName: cps.nome,
        baseTopic: cps.topic,
        lifecycleCpsId: cps.lifecycle?.cpsId || cps.id,
        lifecycleCpsName: cps.lifecycle?.cpsName || cps.nome,
        lifecycleBaseTopic: cps.lifecycle?.baseTopic || cps.topic,
        ts: Date.now(),
        source: ACTIVE_ACSM.code,
      };

      try {
        mqttClient.publish(cmdTopic, JSON.stringify(payload), {
          qos: 1,
          retain: false,
        });

        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[CMD] ${action.toUpperCase()} sent to ${cps.nome} on ${cmdTopic}`,
          },
        ]);

        return true;
      } catch (e) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[CMD_ERROR] Failed to send ${action} to ${cps.nome}: ${e?.message || e}`,
          },
        ]);
        return false;
      }
    },
    [mqttClient]
  );

  const scheduleFeatureUiUpdate = useCallback((ownerId, featKey, statusKey, ts, details) => {
    const k = `${ownerId}::${featKey}`;
    const now = Date.now();
    const lastEmit = featLastEmitRef.current[k] || 0;
    const elapsed = now - lastEmit;

    featPendingRef.current[k] = { ownerId, featKey, statusKey, ts, details };

    const flush = () => {
      const pending = featPendingRef.current[k];
      if (!pending) return;

      featLastEmitRef.current[k] = Date.now();
      delete featPendingRef.current[k];

      const timerId = featTimerRef.current[k];
      if (timerId) clearTimeout(timerId);
      delete featTimerRef.current[k];

      setAddedCPS((prev) =>
        prev.map((c) => {
          if (c.id !== pending.ownerId) return c;

          const funcs = (c.funcionalidades || []).map((f) => {
            if (f.key !== pending.featKey) return f;
            return {
              ...f,
              statusAtual: pending.statusKey ?? (f.statusAtual ?? null),
              lastUpdate: pending.ts,
              lastDetails: pending.details,
            };
          });

          return { ...c, funcionalidades: funcs };
        })
      );

      setRegistry((prev) => {
        const next = { ...prev };
        const baseObj = Object.values(next).find((x) => x?.id === pending.ownerId);
        if (!baseObj) return prev;

        const funcs = (baseObj.funcionalidades || []).map((f) => {
          if (f.key !== pending.featKey) return f;
          return {
            ...f,
            statusAtual: pending.statusKey ?? (f.statusAtual ?? null),
            lastUpdate: pending.ts,
            lastDetails: pending.details,
          };
        });

        const updated = { ...baseObj, funcionalidades: funcs };

        [
          updated.nome,
          updated.id,
          updated.topic,
          updated.lifecycle?.cpsName,
          updated.lifecycle?.cpsId,
          updated.lifecycle?.baseTopic,
        ]
          .filter(Boolean)
          .map((v) => String(v).toLowerCase())
          .forEach((k2) => {
            next[k2] = updated;
          });

        return next;
      });
    };

    if (elapsed >= FEATURE_UI_UPDATE_MS && !featTimerRef.current[k]) {
      flush();
      return;
    }

    if (!featTimerRef.current[k]) {
      const wait = Math.max(0, FEATURE_UI_UPDATE_MS - elapsed);
      featTimerRef.current[k] = setTimeout(flush, wait);
    }
  }, []);

  const restoreCPSFromMaintenance = useCallback(
    async (cpsObj, payload = {}) => {
      if (!cpsObj) return false;

      if (isPhysicalCps(cpsObj)) {
        const completedTs = payload?.ts || payload?.timestamp || Date.now();

        const completedEntry = {
          id: `${cpsObj.id}-plug-complete-${completedTs}`,
          type: payload?.type || 'update_functions',
          title: 'Plug completed',
          message: payload?.summary || 'CPS ready for Plug and Governance validation.',
          ts: completedTs,
        };
        const plugLifecycle = lifecycleWithPhase(cpsObj, 'plug');
        patchRegistryCps(cpsObj, {
          maintenance: {
            ...(cpsObj.maintenance || {}),
            inProgress: false,
            lastEndTs: completedTs,
          },
          lifecycle: plugLifecycle,
          lifecyclePhase: 'plug',
          updates: {
            lastMessage: completedEntry.message,
            lastType: completedEntry.type,
            lastTs: completedTs,
          },
        });
        publishCpsLai1LifecyclePhase(cpsObj, 'plug');
        appendRegistryHistory(cpsObj, completedEntry);
        persistPlugEvent({
          eventType: 'PLUG_COMPLETED',
          cpsId: cpsObj.id,
          cpsName: cpsObj.nome,
          topic: cpsObj.topic,
          message: completedEntry.message,
          details: {
            historyEntry: completedEntry,
          },
          ts: completedTs,
        });
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[PLUG_COMPLETED] ${cpsObj.nome || cpsObj.id} entered Plug Phase for Governance validation.`,
          },
        ]);
        return true;
      }

      const governedCps = governanceWithProfile(cpsObj, governanceProfilesRef.current[cpsObj.id]);
      const alreadyInPlay = addedCPSRef.current.some((c) => c.id === governedCps.id);
      if (alreadyInPlay) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[AUTO_RETURN] ${cpsObj.nome} already in Play Phase.`,
          },
        ]);
        return false;
      }

      const completedTs = payload?.ts || Date.now();
      publishCpsLai1LifecyclePhase(governedCps, 'return');

      const maintenanceCompletedEntry = {
        id: `${cpsObj.id}-maintenance-complete-${completedTs}`,
        type: payload?.type || 'update_functions',
        title: 'Maintenance completed',
        message:
          payload?.summary || 'Maintenance completed. CPS resumed operation autonomously.',
        ts: completedTs,
      };

      const restored = {
        ...governedCps,
        status: mapOperationalStateToDisplayStatus('running'),
        operationalState: 'running',
        maintenance: {
          ...(governedCps.maintenance || {}),
          inProgress: false,
          lastEndTs: completedTs,
        },
        lifecycle: lifecycleWithPhase(governedCps, 'play'),
        lifecyclePhase: 'play',
        updates: {
          ...(governedCps.updates || {}),
          lastMessage:
            payload?.summary || 'Maintenance completed. CPS resumed operation autonomously.',
          lastType: payload?.type || 'update_functions',
          lastTs: completedTs,
          history: [
            maintenanceCompletedEntry,
            ...(Array.isArray(governedCps?.updates?.history) ? governedCps.updates.history : []),
          ].slice(0, 20),
        },
        globalState: {
          ...(governedCps.globalState || {}),
          state: 'running',
          status: 'running',
          summary: payload?.summary || 'CPS returned automatically after maintenance.',
          lastUpdate: completedTs,
        },
        operationalData: operationalDataForAcsmState(governedCps, 'running'),
      };

      rememberOperationMode(governedCps, 'running');
      setAddedCPS((prev) => [...prev, restored]);

      patchRegistryCps(governedCps, {
        status: mapOperationalStateToDisplayStatus('running'),
        operationalState: 'running',
        maintenance: {
          inProgress: false,
          lastEndTs: completedTs,
        },
        lifecycle: lifecycleWithPhase(governedCps, 'play'),
        lifecyclePhase: 'play',
        updates: {
          lastMessage:
            payload?.summary || 'Maintenance completed. CPS resumed operation autonomously.',
          lastType: payload?.type || 'update_functions',
          lastTs: completedTs,
        },
        globalState: {
          state: 'running',
          status: 'running',
          summary: payload?.summary || 'CPS returned automatically after maintenance.',
          lastUpdate: completedTs,
        },
        operationalData: operationalDataForAcsmState(governedCps, 'running'),
      });

      appendRegistryHistory(governedCps, maintenanceCompletedEntry);

      persistPlugEvent({
        eventType: 'maintenance_completed',
        cpsId: governedCps.id,
        cpsName: governedCps.nome,
        topic: governedCps.topic,
        message:
          payload?.summary || 'Maintenance completed. CPS resumed operation autonomously.',
        details: {
          historyEntry: maintenanceCompletedEntry,
          payload,
        },
        ts: completedTs,
      });

      pushSystemEvent({
        ts: completedTs,
        type: 'maintenance_completed',
        cpsId: governedCps.id,
        cpsName: governedCps.nome,
        message:
          payload?.summary || 'Maintenance completed. CPS resumed operation autonomously.',
      });

      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message:
            `[AUTO_RETURN] ${restored.nome} returned automatically to Play Phase ` +
            `after maintenance (id=${restored.id}, topic=${restored.topic}).`,
        },
        {
          time: new Date().toLocaleTimeString(),
          message:
            `[UPDATE_FUNCTIONS] ${restored.nome} notified ${ACTIVE_ACSM.code} that maintenance was completed ` +
            `and the CPS resumed operation autonomously.`,
        },
      ]);

      return true;
    },
    [
      patchRegistryCps,
      appendRegistryHistory,
      persistPlugEvent,
      pushSystemEvent,
      publishCpsLai1LifecyclePhase,
      rememberOperationMode,
    ]
  );

  const handleAnalyticsMessageRef = useRef(handleAnalyticsMessage);
  useEffect(() => {
    handleAnalyticsMessageRef.current = handleAnalyticsMessage;
  }, [handleAnalyticsMessage]);

  const patchRegistryCpsRef = useRef(patchRegistryCps);
  useEffect(() => {
    patchRegistryCpsRef.current = patchRegistryCps;
  }, [patchRegistryCps]);

  const restoreCPSFromMaintenanceRef = useRef(restoreCPSFromMaintenance);
  useEffect(() => {
    restoreCPSFromMaintenanceRef.current = restoreCPSFromMaintenance;
  }, [restoreCPSFromMaintenance]);

  const recordMaintenanceEnteredRef = useRef(recordMaintenanceEntered);
  useEffect(() => {
    recordMaintenanceEnteredRef.current = recordMaintenanceEntered;
  }, [recordMaintenanceEntered]);

  const scheduleFeatureUiUpdateRef = useRef(scheduleFeatureUiUpdate);
  useEffect(() => {
    scheduleFeatureUiUpdateRef.current = scheduleFeatureUiUpdate;
  }, [scheduleFeatureUiUpdate]);

  const appendRegistryHistoryRef = useRef(appendRegistryHistory);
  useEffect(() => {
    appendRegistryHistoryRef.current = appendRegistryHistory;
  }, [appendRegistryHistory]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let client;
    let isDisposed = false;

    const pushMqttLog = (message) => {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message,
        },
      ]);
    };

    const start = async () => {
      try {
        const connect = await loadMqttConnect();
        if (!connect) {
          pushMqttLog('[MQTT_ERROR] Could not load mqtt connect(). Recommend mqtt@^5.');
          return;
        }

        client = connect(DEFAULT_BROKER_URL, {
          clean: true,
          reconnectPeriod: 1000,
          clientId: `cps-ui-${Math.random().toString(16).slice(2)}`,
        });

        pushMqttLog(`[MQTT_CONNECTING] Connecting to ${DEFAULT_BROKER_URL}`);

        client.on('connect', () => {
          if (isDisposed) return;
          setMqttClient(client);
          setMqttConnectionEpoch((value) => value + 1);
          pushMqttLog(`[MQTT_CONNECT] Connected to ${DEFAULT_BROKER_URL}`);

          const analyticsSubs = Array.from(new Set([
            '+/oee',
            '+/learning',
            'acsm/+/learning',
            '+/local/adaptive',
            '+/level2/intelligence',
            ACSM_TOPICS.wildcardOee,
            ACSM_TOPICS.wildcardLearning,
            ACSM_TOPICS.globalOee,
            ACSM_TOPICS.globalReasoning,
            ACSM_TOPICS.globalLearning,
            ...COORDINATOR_REMOTE_TOPICS,
            ...LEVEL2_INTELLIGENCE_TOPICS,
            ...LEVEL3_INPUT_TOPICS,
            ACSM_TOPICS.chainGlobalState,
            ACSM_TOPICS.chainGlobalReasoning,
            ACSM_TOPICS.chainGlobalLearning,
            ACSM_TOPICS.chainCoordinatorOutput,
            ACSM_TOPICS.chainKnowledgeGlobal,
            ACSM_TOPICS.chainKnowledgeExecutive,
            ACSM_TOPICS.supplyChainReasoning,
            SUPPLY_CHAIN_REASONING_TOPIC,
            SUPPLY_CHAIN_FEEDBACK_GLOBAL_TOPIC,
            SUPPLY_CHAIN_FEEDBACK_LOCAL_TOPIC,
            LOCAL_ADAPTIVE_INTELLIGENCE_TOPIC,
            SERVICE_ADAPTIVE_INTELLIGENCE_TOPIC,
            AI_ENRICHED_ANALYTICS_TOPIC,
            LIFECYCLE_UNPLUG_REQUEST_TOPIC,
            LIFECYCLE_UPDATE_FUNCTIONS_TOPIC,
          ].filter(isValidMqttTopic)));

          client.subscribe(analyticsSubs, (err) => {
            pushMqttLog(
              err
                ? `[MQTT_SUBSCRIBE_ERROR] analytics (${err?.message || err})`
                : `[MQTT_SUBSCRIBE] analytics -> ${analyticsSubs.join(', ')}`
            );
            if (err) {
              console.error('[MQTT SUBSCRIBE ERROR]', AI_ENRICHED_ANALYTICS_TOPIC, err);
            } else {
              console.log('[MQTT SUBSCRIBED]', AI_ENRICHED_ANALYTICS_TOPIC);
            }
          });

          const dynamicSubs = Array.from(
            new Set(
              availableCPSRef.current
                .flatMap((cps) => buildSubscriptionTopicsForCps(cps))
                .filter(isValidMqttTopic)
            )
          );

          if (dynamicSubs.length) {
            client.subscribe(dynamicSubs, (err) => {
              pushMqttLog(
                err
                  ? `[MQTT_SUBSCRIBE_ERROR] cps_dynamic (${err?.message || err})`
                  : `[MQTT_SUBSCRIBE] cps_dynamic -> ${dynamicSubs.length} topics`
              );
            });
          }
        });

        client.on('reconnect', () => {
          pushMqttLog('[MQTT_RECONNECT] Broker reconnect attempt started.');
        });

        client.on('close', () => {
          pushMqttLog('[MQTT_CLOSE] Connection closed.');
        });

        client.on('offline', () => {
          pushMqttLog('[MQTT_OFFLINE] Client went offline.');
        });

        client.on('message', (topic, message) => {
          const rawTopic = String(topic || '').trim();
          const normIncoming = normalizeTopic(rawTopic);
          const rawStr = message?.toString?.() || '';

          pushMqttLog(`[MQTT_MESSAGE] ${rawTopic}`);

          if (DEBUG_LOG_ALL_TOPICS) {
            pushMqttLog(`[DEBUG] msg in '${rawTopic}': ${rawStr}`);
          }

          if (normIncoming === SUPPLY_CHAIN_REASONING_TOPIC) {
            const payload = safeParseJson(message) || {};
            const normalized = normalizeSupplyChainPackage(payload);
            setSupplyChainPackage(normalized);
            if (typeof window !== 'undefined') {
              localStorage.setItem(LEVEL3_LAST_PAYLOAD_KEY, JSON.stringify(normalized));
            }
            return;
          }

          if (
            normIncoming === SUPPLY_CHAIN_FEEDBACK_GLOBAL_TOPIC ||
            normIncoming === SUPPLY_CHAIN_FEEDBACK_LOCAL_TOPIC ||
            normIncoming.includes('supplychain/feedback')
          ) {
            const payload = safeParseJson(message) || {};
            const normalized = normalizeSupplyChainFeedback(payload, ACTIVE_ACSM.id);
            setSupplyChainFeedback({
              lastUpdate: Date.now(),
              globalAssessment: normalized.globalAssessment,
              globalDirectives: normalized.globalDirectives,
              adaptiveLearning: normalized.adaptiveLearning,
              adaptiveTimeline: normalized.adaptiveTimeline,
              local: normalized.local,
              raw: payload,
            });
            return;
          }

          if (normIncoming === LOCAL_ADAPTIVE_INTELLIGENCE_TOPIC) {
            const payload = safeParseJson(message) || {};
            setLocalAdaptiveIntelligence({
              lastUpdate: Date.now(),
              adaptiveLearningLocal: payload.adaptiveLearningLocal || null,
              adaptiveTimelineLocal: Array.isArray(payload.adaptiveTimelineLocal)
                ? payload.adaptiveTimelineLocal
                : [],
              raw: payload,
            });
            return;
          }

          if (normIncoming === SERVICE_ADAPTIVE_INTELLIGENCE_TOPIC) {
            const payload = safeParseJson(message) || {};
            setServiceAdaptiveIntelligence({
              lastUpdate: Date.now(),
              adaptiveLearningService: payload.adaptiveLearningService || null,
              adaptiveTimelineService: Array.isArray(payload.adaptiveTimelineService)
                ? payload.adaptiveTimelineService
                : [],
              raw: payload,
            });
            return;
          }

          if (normIncoming.endsWith('/local/adaptive')) {
            const payload = safeParseJson(message) || {};
            const topicBase = normalizeTopic(normIncoming).split('/')[0] || '';
            const cpsId = normalizeCpsId(payload?.cpsId || payload?.source || topicBase);
            if (cpsId && cpsId.startsWith('cps')) {
              setCpsAdaptiveIntelligence((prev) => ({
                ...prev,
                [cpsId]: {
                  ...emptyCpsAdaptiveEntry(),
                  lastUpdate: Date.now(),
                  adaptiveLearningCps: payload.adaptiveLearningCps || null,
                  adaptiveTimelineCps: Array.isArray(payload.adaptiveTimelineCps)
                    ? payload.adaptiveTimelineCps
                    : [],
                  raw: payload,
                },
              }));
            }
            return;
          }

          if (isAiEnrichedAnalyticsTopic(normIncoming)) {
            const data =
              message && typeof message === 'object' && !ArrayBuffer.isView(message)
                ? message
                : safeParseJson(message);

            if (!data) {
              console.warn('[AI ENRICHED RECEIVED] Unable to parse payload', {
                topic: normIncoming,
                rawPayload: rawStr?.slice?.(0, 500) || rawStr,
              });
              return;
            }

            const cpsId =
              normalizeCpsId(data?.cpsId) ||
              getAiEnrichedAnalyticsCpsIdFromTopic(normIncoming);

            if (!cpsId) {
              console.warn('[AI ENRICHED RECEIVED] Unable to resolve cpsId', {
                topic: normIncoming,
                payloadCpsId: data?.cpsId,
              });
              return;
            }

            console.log('[AI ENRICHED RECEIVED]', {
              topic: normIncoming,
              cpsId,
              analysisMode: data?.analysisMode || 'light',
              analysisSource: data?.analysisSource || 'live',
              aiLastUpdate: data?.timestamp || data?.ts || null,
              hasEnrichedAnalysis: Boolean(data?.enrichedAnalysis || data?.ai || data?.analysis || data?.summary),
            });

            setCpsAnalyticsState((prev) => {
              const nextEntry = buildAiEnrichedAnalyticsEntry(prev?.[cpsId] || {}, cpsId, data);
              console.log('[AI ENRICHED STATE KEY]', {
                cpsId,
                analysisMode: nextEntry.analysisMode,
                analysisSource: nextEntry.analysisSource,
                previousAiLastUpdate: prev?.[cpsId]?.aiLastUpdate || null,
                aiLastUpdate: nextEntry.aiLastUpdate,
              });

              return {
                ...prev,
                [cpsId]: nextEntry,
              };
            });

            setLog((prev) => [
              ...prev,
              {
                time: new Date().toLocaleTimeString(),
                message: `[AI_ANALYTICS] ${cpsId} enriched analysis (${data?.analysisMode || 'light'})`,
              },
            ]);

            return;
          }

          const isAnalyticsTopic =
            isLevel2IntelligenceTopic(normIncoming) ||
            LEVEL3_INPUT_TOPICS.includes(normIncoming) ||
            COORDINATOR_REMOTE_TOPICS.includes(normIncoming) ||
            normIncoming.endsWith('/learning') ||
            normIncoming.endsWith('/oee') ||
            normIncoming === ACSM_TOPICS.globalOee ||
            normIncoming === ACSM_TOPICS.globalReasoning ||
            normIncoming === ACSM_TOPICS.globalLearning ||
            normIncoming === ACSM_TOPICS.chainGlobalState ||
            normIncoming === ACSM_TOPICS.chainGlobalReasoning ||
            normIncoming === ACSM_TOPICS.chainGlobalLearning ||
            normIncoming === ACSM_TOPICS.chainCoordinatorOutput ||
            normIncoming === ACSM_TOPICS.chainKnowledgeGlobal ||
            normIncoming === ACSM_TOPICS.chainKnowledgeExecutive ||
            normIncoming === ACSM_TOPICS.supplyChainReasoning;

          if (isAnalyticsTopic) {
            handleAnalyticsMessageRef.current?.(normIncoming, message);
            return;
          }

          if (normIncoming === LIFECYCLE_UNPLUG_REQUEST_TOPIC) {
            const payload = safeParseJson(message);
            if (!payload?.baseTopic && !payload?.cpsId) return;

            const target =
              addedCPSRef.current.find(
                (c) =>
                  c.id === String(payload?.cpsId || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1') ||
                  normalizeTopic(c.topic) === normalizeTopic(payload?.baseTopic)
              ) ||
              Object.values(registryRef.current || {}).find(
                (c) =>
                  c?.id === String(payload?.cpsId || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1') ||
                  normalizeTopic(c?.topic) === normalizeTopic(payload?.baseTopic)
              );

            if (!target) return;

            const now = Date.now();
            const last = lastAutoUnplugRef.current[target.id] || 0;
            if (now - last < AUTOUNPLUG_DEDUP_MS) return;
            lastAutoUnplugRef.current[target.id] = now;

            if (isMaintenanceReason(payload?.reason)) {
              maintenanceReturnRef.current[target.id] = true;
              recordMaintenanceEnteredRef.current?.(
                target,
                payload,
                target?.operationalState || target?.globalState?.state || 'running'
              );
            }

            setTimeout(() => {
              const nextState = isMaintenanceReason(payload?.reason) ? 'maintenance' : 'unplugged';
              rememberOperationMode(target, nextState);
              setAddedCPS((prev) => prev.filter((c) => c.id !== target.id));
              const unplugLifecycle = lifecycleWithPhase(target, 'unplug');
              patchRegistryCpsRef.current?.(target, {
                status: mapOperationalStateToDisplayStatus(nextState),
                operationalState: nextState,
                maintenance: {
                  ...(target.maintenance || {}),
                  inProgress: isMaintenanceReason(payload?.reason),
                  lastStartTs: payload?.ts || Date.now(),
                },
                lifecycle: unplugLifecycle,
                lifecyclePhase: 'unplug',
                globalState: {
                  ...(target.globalState || {}),
                  state: nextState,
                  status: nextState,
                  summary: payload?.summary || 'CPS unplugged from Play Phase.',
                  lastUpdate: payload?.ts || Date.now(),
                },
                operationalData: operationalDataForAcsmState(target, nextState),
              });
              publishCpsLai1LifecyclePhaseRef.current?.(target, 'unplug');
            }, 0);

            appendRegistryHistoryRef.current?.(target, {
              id: `${target.id}-unplug-${payload?.ts || Date.now()}`,
              type: payload?.type || 'unplug_request',
              title: 'Autonomous unplug',
              message: payload?.summary || 'CPS requested unplug.',
              ts: payload?.ts || Date.now(),
            });

            persistPlugEvent({
              id: `${target.id}-unplug-${payload?.ts || Date.now()}`,
              eventType: 'UNPLUG',
              cpsId: target.id,
              cpsName: target.nome,
              topic: target.topic,
              message: payload?.summary || 'CPS requested unplug.',
              details: { reason: payload?.reason || null, source: payload?.source || null },
              ts: payload?.ts || Date.now(),
            });

            return;
          }

          if (normIncoming === LIFECYCLE_UPDATE_FUNCTIONS_TOPIC) {
            const payload = safeParseJson(message);
            if (!payload) return;

            const target =
              Object.values(registryRef.current || {}).find(
                (c) =>
                  c?.id ===
                    String(payload?.cpsId || '')
                      .toLowerCase()
                      .replace(/[^a-z0-9]/g, '')
                      .replace(/(cps)0+/, '$1') ||
                  normalizeTopic(c?.topic) === normalizeTopic(payload?.baseTopic)
              ) || null;

            if (!target) return;

            const lifecyclePhase = getCpsLifecyclePhase(target);
            if (
              maintenanceReturnRef.current[target.id] ||
              isMaintenanceReason(payload?.reason) ||
              (isPhysicalCps(target) && lifecyclePhase === 'unplug')
            ) {
              Promise.resolve(restoreCPSFromMaintenanceRef.current?.(target, payload)).then(
                (completed) => {
                  if (completed) maintenanceReturnRef.current[target.id] = false;
                }
              );
              return;
            }
          }

          const current = addedCPSRef.current;
          const matchesTopic = (cps) => {
            const base = normalizeTopic(cps?.topic);
            return base && (normIncoming === base || normIncoming.startsWith(`${base}/`));
          };
          const owner = withRememberedOperationMode(
            current.find(matchesTopic) || Object.values(registryRef.current || {}).find(matchesTopic)
          );

          if (!owner) return;

          const isAck =
            normIncoming.endsWith(`/${ACK_TOPIC_SUFFIX}`) ||
            normIncoming.includes(`/${ACK_TOPIC_SUFFIX}/`);

          if (isAck) {
            const ack = safeParseJson(message);
            setLog((prev) => [
              ...prev,
              {
                time: new Date().toLocaleTimeString(),
                message: ack
                  ? `[ACK] ${owner.nome} -> action=${ack?.action || '-'} ok=${String(ack?.ok ?? '-')}`
                  : `[ACK] non-JSON payload in '${rawTopic}': ${rawStr}`,
              },
            ]);
            return;
          }

          const isData =
            normIncoming.endsWith(`/${DATA_TOPIC_SUFFIX}`) ||
            normIncoming.includes(`/${DATA_TOPIC_SUFFIX}/`);

          const isStatus =
            normIncoming.endsWith(`/${STATUS_TOPIC_SUFFIX}`) ||
            normIncoming.includes(`/${STATUS_TOPIC_SUFFIX}/`);

          const isHealth =
            normIncoming.endsWith(`/${HEALTH_TOPIC_SUFFIX}`) ||
            normIncoming.includes(`/${HEALTH_TOPIC_SUFFIX}/`);

          const isOee =
            normIncoming.endsWith(`/${OEE_TOPIC_SUFFIX}`) ||
            normIncoming.includes(`/${OEE_TOPIC_SUFFIX}/`);

          const isExperimentalMetrics =
            normIncoming.endsWith('/experimental-metrics') ||
            normIncoming.includes('/experimental-metrics/');

          const isAlarm =
            normIncoming.endsWith(`/${ALARM_TOPIC_SUFFIX}`) ||
            normIncoming.includes(`/${ALARM_TOPIC_SUFFIX}/`);

          const ownerOperationallyRunning = isCpsOperationallyRunning(owner);

          const featInfo = parseFeatureStateTopic(owner.topic, normIncoming);
          if (featInfo?.featKey) {
            if (!ownerOperationallyRunning) return;

            const payload = safeParseJson(message);
            if (!payload) {
              setLog((prev) => [
                ...prev,
                {
                  time: new Date().toLocaleTimeString(),
                  message: `[FEAT] non-JSON payload in '${rawTopic}': ${rawStr}`,
                },
              ]);
              return;
            }

            const statusKey = normalizeFeatureStatusEN(payload?.status);
            const ts = payload?.ts || Date.now();
            const details = payload?.details;

            scheduleFeatureUiUpdateRef.current?.(
              owner.id,
              featInfo.featKey,
              statusKey,
              ts,
              details
            );

            if (statusKey === 'failure' || statusKey === 'maintenance') {
              const compName =
                owner.funcionalidades?.find((f) => f.key === featInfo.featKey)?.nome ||
                featInfo.featKey;

              const alertObj = {
                id: `${owner.id}-${featInfo.featKey}-${ts}`,
                cpsId: owner.id,
                cpsName: owner.nome,
                component: compName,
                severity: statusKey === 'failure' ? 'high' : 'medium',
                timestamp: new Date(ts).toISOString(),
                raw: {
                  type: 'feature_state',
                  status: statusKey,
                  featKey: featInfo.featKey,
                  plant: featInfo.plant,
                  details,
                },
              };

              setAlerts((prev) => [alertObj, ...prev].slice(0, 200));
              setLog((prev) => [
                ...prev,
                {
                  time: new Date().toLocaleTimeString(),
                  message: `[FEAT] ${owner.nome} - ${compName} -> status=${statusKey}`,
                },
              ]);
            }

            return;
          }

          if (isHealth) {
            const healthOwnerId = normalizeCpsId(owner?.id ?? owner?.cpsId);
            if (healthOwnerId === 'cpslai2' || healthOwnerId === 'cpslai3') return;
            const data = safeParseJson(message);
            if (!data) {
              setLog((prev) => [
                ...prev,
                {
                  time: new Date().toLocaleTimeString(),
                  message: `[HEALTH] non-JSON payload in '${rawTopic}': ${rawStr}`,
                },
              ]);
              return;
            }

            if (!isNewerSnapshot(data?.ts ?? data?.timestamp, owner?.health?.lastUpdate)) return;

            setAddedCPS((prev) =>
              prev.map((c) =>
                c.id === owner.id
                  ? {
                      ...c,
                      health: {
                        score: data?.score ?? data?.health ?? data?.healthScore ?? c?.health?.score ?? null,
                        label: data?.healthState ?? data?.state ?? data?.healthLabel ?? c?.health?.label ?? null,
                        healthType: data?.healthType ?? c?.health?.healthType ?? null,
                        communication: data?.communication ?? c?.health?.communication ?? null,
                        evidence: data?.evidence ?? c?.health?.evidence ?? null,
                        note: data?.note ?? c?.health?.note ?? null,
                        sourceStatus: data?.sourceStatus ?? c?.health?.sourceStatus ?? null,
                        lastUpdate: data?.timestamp ?? data?.ts ?? Date.now(),
                      },
                    }
                  : c
              )
            );

            patchRegistryCpsRef.current?.(owner, {
              health: {
                score: data?.score ?? data?.health ?? data?.healthScore ?? owner?.health?.score ?? null,
                label: data?.healthState ?? data?.state ?? data?.healthLabel ?? owner?.health?.label ?? null,
                healthType: data?.healthType ?? owner?.health?.healthType ?? null,
                communication: data?.communication ?? owner?.health?.communication ?? null,
                evidence: data?.evidence ?? owner?.health?.evidence ?? null,
                note: data?.note ?? owner?.health?.note ?? null,
                sourceStatus: data?.sourceStatus ?? owner?.health?.sourceStatus ?? null,
                lastUpdate: data?.timestamp ?? data?.ts ?? Date.now(),
              },
            });

            return;
          }

          if (isOee) {
            handleAnalyticsMessageRef.current?.(normIncoming, message);
            return;
          }

          if (isExperimentalMetrics) {
            if (normalizeCpsId(owner?.id ?? owner?.cpsId) !== 'cpslai3') return;
            const data = safeParseJson(message);
            if (!data || normalizeCpsId(data?.cpsId) !== 'cpslai3') return;
            const updateAt = data?.updatedAt ?? data?.timestamp;
            if (!isNewerSnapshot(updateAt, owner?.experimentalMetrics?.updatedAt)) return;

            const experimentalMetrics = {
              ...data,
              updatedAt: updateAt ?? new Date().toISOString(),
            };
            setAddedCPS((prev) => prev.map((c) =>
              normalizeCpsId(c?.id ?? c?.cpsId) === 'cpslai3'
                ? { ...c, experimentalMetrics }
                : c
            ));
            patchRegistryCpsRef.current?.(owner, { experimentalMetrics });
            return;
          }

          if (isStatus) {
            const data = safeParseJson(message);
            if (!data) return;

            if (
              normalizeCpsId(owner?.id ?? owner?.cpsId) === 'cpslai3' &&
              data?.communication && typeof data.communication.connected === 'boolean'
            ) {
              cpsLai3StatusCommunicationRef.current = {
                connected: data.communication.connected,
                statusTimestamp: data.communication.statusTimestamp ?? null,
                receivedAt: Date.now(),
              };
            }

            if (!isNewerSnapshot(data?.ts ?? data?.timestamp, owner?.globalState?.lastUpdate)) return;

            const isCpsLai1Status = normalizeCpsId(owner?.id) === 'cpslai1';
            const isCpsLai2Status = normalizeCpsId(owner?.id) === 'cpslai2';
            const isCpsLai3Status = normalizeCpsId(owner?.id) === 'cpslai3';
            const explicitOperationalState = isCpsLai1Status || isCpsLai2Status || isCpsLai3Status
              ? getStatusOperationalState(data)
              : getExplicitOperationMode(data);
            const explicitCanonicalState =
              explicitOperationalState !== null
                ? canonicalOperationMode(explicitOperationalState)
                : null;
            const nextGlobalState = {
              ...(owner.globalState || {}),
              state:
                explicitCanonicalState ?? (data?.state || owner?.globalState?.state || null),
              status:
                explicitCanonicalState ??
                (data?.status || data?.state || owner?.globalState?.status || null),
              playEnabled:
                typeof data?.playEnabled === 'boolean'
                  ? data.playEnabled
                  : owner?.globalState?.playEnabled ?? true,
              healthScore: data?.healthScore ?? owner?.globalState?.healthScore ?? null,
              healthLabel: data?.healthLabel ?? owner?.globalState?.healthLabel ?? null,
              featureCount:
                data?.featureCount ?? owner?.globalState?.featureCount ?? owner?.funcionalidades?.length ?? 0,
              summary: data?.summary || owner?.globalState?.summary || '',
              lastUpdate: data?.ts ?? Date.now(),
            };
            const nextCanonicalState = canonicalOperationMode(
              explicitCanonicalState ?? nextGlobalState.state ?? nextGlobalState.status
            );
            const operationalHealth = isCpsLai1Status
              ? buildCpsOperationalHealth({
                  cpsId: owner.id,
                  communication: data?.communication,
                  operationalState: nextCanonicalState,
                  timestamp: data?.timestamp ?? data?.ts ?? new Date(),
                })
              : null;
            if (nextCanonicalState === 'maintenance') {
              recordMaintenanceEnteredRef.current?.(
                owner,
                data,
                owner?.operationalState || owner?.globalState?.state || owner?.operationalData?.operationMode
              );
            }
            const nextOperationalData = isCpsLai1Status
              ? applyPhysicalStatus(owner, data)
              : isCpsLai2Status
                ? { ...(owner?.operationalData || {}) }
              : isCpsLai3Status
                ? {
                    ...(owner?.operationalData || {}),
                    operationModeRaw:
                      data?.operationModeRaw ?? owner?.operationalData?.operationModeRaw ?? null,
                    operationModeSemanticStatus:
                      data?.operationModeSemanticStatus ??
                      owner?.operationalData?.operationModeSemanticStatus ??
                      'PENDING',
                  }
              : operationalDataWithMode(owner, nextCanonicalState);
            if (!isCpsLai1Status && !isCpsLai2Status && !isCpsLai3Status) {
              rememberOperationMode(owner, nextCanonicalState);
            }
            const nextLifecyclePhase = isCpsLai1Status ? null : getCpsLifecyclePhase(data);
            const lifecyclePatch = nextLifecyclePhase
              ? {
                  lifecycle: lifecycleWithPhase(owner, nextLifecyclePhase),
                  lifecyclePhase: nextLifecyclePhase,
                }
              : {};

            setAddedCPS((prev) =>
              prev.map((c) =>
                c.id === owner.id
                  ? {
                      ...c,
                      ...lifecyclePatch,
                      status: mapOperationalStateToDisplayStatus(nextCanonicalState),
                      operationalState: nextCanonicalState,
                      globalState: nextGlobalState,
                      // cpslai3/data is the sole source of its physical mode evidence.
                      // A near-simultaneous /status message may hold a pre-render owner
                      // snapshot and must not replace the evidence just stored by /data.
                      operationalData: isCpsLai3Status
                        ? c?.operationalData
                        : nextOperationalData,
                      ...(operationalHealth
                        ? {
                            health: {
                              score: operationalHealth.score,
                              label: operationalHealth.healthState,
                              healthType: operationalHealth.healthType,
                              communication: operationalHealth.communication,
                              evidence: operationalHealth.evidence,
                              note: operationalHealth.note,
                              lastUpdate: operationalHealth.timestamp,
                            },
                          }
                        : {}),
                    }
                  : c
              )
            );
            patchRegistryCpsRef.current?.(owner, {
              ...lifecyclePatch,
              status: mapOperationalStateToDisplayStatus(nextCanonicalState),
              operationalState: nextCanonicalState,
              globalState: nextGlobalState,
              ...(isCpsLai3Status ? {} : { operationalData: nextOperationalData }),
              ...(operationalHealth
                ? {
                    health: {
                      score: operationalHealth.score,
                      label: operationalHealth.healthState,
                      healthType: operationalHealth.healthType,
                      communication: operationalHealth.communication,
                      evidence: operationalHealth.evidence,
                      note: operationalHealth.note,
                      lastUpdate: operationalHealth.timestamp,
                    },
                  }
                : {}),
            });
            if (isCpsLai1Status) {
              publishCpsOperationalHealth({
                client,
                topic: joinTopic(owner.topic, HEALTH_TOPIC_SUFFIX),
                cpsId: owner.id,
                status: {
                  communication: data?.communication,
                  operationalState: nextCanonicalState,
                  timestamp: data?.timestamp ?? data?.ts ?? new Date(),
                },
              });
            }
            return;
          }

          if (isData) {
            const data = safeParseJson(message);
            if (!data) return;

            const isCpsLai1Data = isPhysicalCps(owner);
            const isCpsLai2Data = normalizeCpsId(owner?.id || owner?.cpsId) === 'cpslai2';
            const isCpsLai3Data = normalizeCpsId(owner?.id || owner?.cpsId) === 'cpslai3';
            const explicitDataOperationMode = getExplicitOperationMode(data);
            const runtimeDataOperationMode =
              !isCpsLai1Data && !isCpsLai2Data && !isCpsLai3Data &&
              isRuntimeOperationMode(explicitDataOperationMode)
              ? canonicalOperationMode(explicitDataOperationMode)
              : null;
            const ownerForDataCheck =
              runtimeDataOperationMode !== null
                ? {
                    ...owner,
                    operationalData: operationalDataWithMode(owner, runtimeDataOperationMode),
                  }
                : owner;

            if (isCpsLai2Data && data?.data && typeof data.data === 'object') {
              const cpsId = 'cpslai2';
              const receivedAt = Date.now();
              const timeoutMs = Number(data?.staleAfterMs) > 0
                ? Number(data.staleAfterMs)
                : 6000;
              const previousTelemetry = telemetryDataRef.current[cpsId] || null;
              const mergedTelemetry = mergeCpsTelemetry(previousTelemetry, data);
              const physicalOperationMode = getCpsLai2PhysicalOperationMode(mergedTelemetry, true);
              const updateCpsLai2TechnicalHealth = (dataFresh, timestamp = new Date()) => {
                const currentOwner = Object.values(registryRef.current || {}).find(
                  (entry) => normalizeCpsId(entry?.id || entry?.cpsId) === cpsId
                ) || owner;
                const operationalHealth = buildCpsLai2TechnicalHealth({
                  cpsId,
                  communication: { dataFresh, dataAgeMs: dataFresh ? 0 : timeoutMs },
                  telemetry: telemetryDataRef.current[cpsId],
                  timestamp,
                });
                const healthTimestamp = new Date(timestamp);
                const health = operationalHealth
                  ? {
                      score: operationalHealth.score,
                      label: operationalHealth.healthState,
                      healthType: operationalHealth.healthType,
                      communication: operationalHealth.communication,
                      evidence: operationalHealth.evidence,
                      note: operationalHealth.note,
                      lastUpdate: operationalHealth.timestamp,
                    }
                  : {
                      score: null,
                      label: 'NOT_COMPUTED',
                      healthType: 'CPS_LAI_02_TECHNICAL_HEALTH',
                      communication: { dataFresh },
                      evidence: {
                        source: 'CPS_LAI_02_OPCUA_MODE_MARKERS',
                        evidenceStatus: 'INSUFFICIENT_EVIDENCE',
                      },
                      note: 'Simplified operational/technical health was not computed because essential OPC UA evidence is unavailable.',
                      lastUpdate: Number.isNaN(healthTimestamp.getTime())
                        ? new Date().toISOString()
                        : healthTimestamp.toISOString(),
                    };
                setAddedCPS((prev) => prev.map((c) =>
                  normalizeCpsId(c?.id || c?.cpsId) === cpsId ? { ...c, health } : c
                ));
                patchRegistryCpsRef.current?.(currentOwner, { health });
              };

              if (mergedTelemetry !== previousTelemetry) {
                telemetryDataRef.current = {
                  ...telemetryDataRef.current,
                  [cpsId]: { ...mergedTelemetry, cpsId },
                };
                setTelemetryData(telemetryDataRef.current);
              }

              telemetryCommunicationReceivedAtRef.current[cpsId] = receivedAt;
              if (telemetryCommunicationTimersRef.current[cpsId]) {
                clearTimeout(telemetryCommunicationTimersRef.current[cpsId]);
              }
              setTelemetryCommunication((prev) => prev[cpsId] === true
                ? prev
                : { ...prev, [cpsId]: true });

              const applyCpsLai2PhysicalMode = (mode) => {
                setAddedCPS((prev) => prev.map((c) =>
                  normalizeCpsId(c?.id || c?.cpsId) === cpsId
                    ? applyCpsLai2PhysicalOperationMode(
                        c,
                        telemetryDataRef.current[cpsId],
                        mode !== 'UNKNOWN'
                      )
                    : c
                ));
                const currentOwner = Object.values(registryRef.current || {}).find(
                  (entry) => normalizeCpsId(entry?.id || entry?.cpsId) === cpsId
                ) || owner;
                if (currentOwner?.operationalData?.operationMode !== mode) {
                  patchRegistryCpsRef.current?.(currentOwner, {
                    operationalData: {
                      ...(currentOwner?.operationalData || {}),
                      operationMode: mode,
                    },
                  });
                }
              };

              applyCpsLai2PhysicalMode(physicalOperationMode);
              updateCpsLai2TechnicalHealth(
                true,
                data?.publishedAt ?? data?.timestamp ?? data?.collectedAt ?? new Date()
              );

              const expireCommunication = () => {
                const lastReceivedAt = telemetryCommunicationReceivedAtRef.current[cpsId];
                const remainingMs = timeoutMs - (Date.now() - lastReceivedAt);
                if (lastReceivedAt && remainingMs > 0) {
                  telemetryCommunicationTimersRef.current[cpsId] = setTimeout(
                    expireCommunication,
                    remainingMs
                  );
                  return;
                }
                if (lastReceivedAt) {
                  setTelemetryCommunication((prev) => prev[cpsId] === false
                    ? prev
                    : { ...prev, [cpsId]: false });
                  applyCpsLai2PhysicalMode('UNKNOWN');
                  updateCpsLai2TechnicalHealth(false);
                }
              };
              telemetryCommunicationTimersRef.current[cpsId] = setTimeout(
                expireCommunication,
                timeoutMs
              );
            }

            if (isCpsLai3Data && data?.data && typeof data.data === 'object') {
              const cpsId = 'cpslai3';
              const timeoutMs = Number(data?.staleAfterMs) > 0 ? Number(data.staleAfterMs) : 6000;
              const receivedAt = Date.now();
              const previousTelemetry = telemetryDataRef.current[cpsId] || null;
              const mergedTelemetry = mergeCpsTelemetry(previousTelemetry, data);
              const dataFresh = data?.communication?.dataFresh === true;
              const recentStatusCommunication = cpsLai3StatusCommunicationRef.current;
              const statusReceiptAgeMs = recentStatusCommunication
                ? receivedAt - recentStatusCommunication.receivedAt
                : Infinity;
              const statusSourceTimestamp = Date.parse(recentStatusCommunication?.statusTimestamp || '');
              const connectedConfirmed = data?.communication?.connected === false &&
                recentStatusCommunication?.connected === false &&
                statusReceiptAgeMs >= 0 && statusReceiptAgeMs <= timeoutMs &&
                Number.isFinite(statusSourceTimestamp);
              const communication = {
                connected: data?.communication?.connected === true
                  ? true
                  : connectedConfirmed ? false : null,
                connectedConfirmed,
                dataFresh: typeof data?.communication?.dataFresh === 'boolean'
                  ? data.communication.dataFresh
                  : null,
                dataMessageReceived: true,
              };

              if (mergedTelemetry !== previousTelemetry) {
                telemetryDataRef.current = {
                  ...telemetryDataRef.current,
                  [cpsId]: { ...mergedTelemetry, cpsId },
                };
                setTelemetryData(telemetryDataRef.current);
              }

              const applyCpsLai3TechnicalHealth = (timeoutConfirmed = false) => {
                const result = buildCpsLai3TechnicalHealth({
                  cpsId,
                  communication: timeoutConfirmed
                    ? { ...communication, connected: null, dataFresh: false }
                    : communication,
                  telemetry: {
                    ...(telemetryDataRef.current[cpsId] || mergedTelemetry),
                    ...data,
                    // Score only evidence carried by this MQTT snapshot; the
                    // operational mode may use merged telemetry, Health may not
                    // fill absent markers with a previous sample.
                    data: data.data,
                  },
                  timestamp: new Date(),
                  timeoutConfirmed,
                });
                const health = result
                  ? {
                      score: result.score,
                      label: result.healthState,
                      healthType: result.healthType,
                      communication: result.communication,
                      evidence: result.evidence,
                      note: result.note,
                      lastUpdate: result.timestamp,
                    }
                  : {
                      score: null,
                      label: 'NOT_COMPUTED',
                      healthType: 'CPS_LAI_03_TECHNICAL_HEALTH',
                      communication,
                      evidence: {
                        source: 'CPS_LAI_03_OPCUA_MODE_MARKERS',
                        evidenceStatus: 'INSUFFICIENT_EVIDENCE',
                        failedChecks: ['INSUFFICIENT_COMMUNICATION_OR_MARKER_EVIDENCE'],
                      },
                      note: 'Technical health was not computed because current communication or OPC UA marker evidence is insufficient.',
                      lastUpdate: new Date().toISOString(),
                    };
                setAddedCPS((prev) => prev.map((c) =>
                  normalizeCpsId(c?.id || c?.cpsId) === cpsId ? { ...c, health } : c
                ));
                const currentOwner = Object.values(registryRef.current || {}).find(
                  (entry) => normalizeCpsId(entry?.id || entry?.cpsId) === cpsId
                ) || owner;
                patchRegistryCpsRef.current?.(currentOwner, { health });
              };

              // Each delivered snapshot refreshes the ACSM receipt watchdog,
              // including snapshots whose OPC UA dataFresh flag is false.
              telemetryCommunicationReceivedAtRef.current[cpsId] = receivedAt;

              const applyCpsLai3PhysicalMode = (communicationFresh) => {
                const evidence = telemetryDataRef.current[cpsId] || null;
                const derived = deriveCpsLai3PhysicalOperationMode({
                  cpsId,
                  evidence,
                  communication: { dataFresh: communicationFresh },
                });
                const operationalDataPatch = {
                  operationMode: derived.valid ? derived.operationMode : 'UNKNOWN',
                  physicalModeEvidence: evidence,
                  physicalModeCommunication: { dataFresh: communicationFresh },
                  physicalModeDerivation: derived,
                };
                setAddedCPS((prev) => prev.map((c) =>
                  normalizeCpsId(c?.id || c?.cpsId) === cpsId
                    ? { ...c, operationalData: { ...(c?.operationalData || {}), ...operationalDataPatch } }
                    : c
                ));
                const currentOwner = Object.values(registryRef.current || {}).find(
                  (entry) => normalizeCpsId(entry?.id || entry?.cpsId) === cpsId
                ) || owner;
                patchRegistryCpsRef.current?.(currentOwner, {
                  operationalData: {
                    ...(currentOwner?.operationalData || {}),
                    ...operationalDataPatch,
                  },
                });
              };

              if (telemetryCommunicationTimersRef.current[cpsId]) {
                clearTimeout(telemetryCommunicationTimersRef.current[cpsId]);
              }
              setTelemetryCommunication((prev) => prev[cpsId] === dataFresh
                ? prev
                : { ...prev, [cpsId]: dataFresh });
              applyCpsLai3PhysicalMode(dataFresh);
              applyCpsLai3TechnicalHealth(false);

              const expireCommunication = () => {
                const lastReceivedAt = telemetryCommunicationReceivedAtRef.current[cpsId];
                const remainingMs = timeoutMs - (Date.now() - lastReceivedAt);
                if (lastReceivedAt && remainingMs > 0) {
                  telemetryCommunicationTimersRef.current[cpsId] = setTimeout(expireCommunication, remainingMs);
                  return;
                }
                if (!lastReceivedAt) return;
                setTelemetryCommunication((prev) => prev[cpsId] === false
                  ? prev
                  : { ...prev, [cpsId]: false });
                applyCpsLai3PhysicalMode(false);
                applyCpsLai3TechnicalHealth(true);
              };
              telemetryCommunicationTimersRef.current[cpsId] = setTimeout(expireCommunication, timeoutMs);
            }

            if (!isNewerSnapshot(data?.ts ?? data?.timestamp, owner?.operationalData?.lastUpdate)) return;

            if (!isCpsOperationallyRunning(ownerForDataCheck)) {
              if (data && runtimeDataOperationMode !== null) {
                rememberOperationMode(owner, runtimeDataOperationMode);
                const nextOperationalData = operationalDataWithMode(owner, runtimeDataOperationMode);
                setAddedCPS((prev) =>
                  prev.map((c) =>
                    c.id === owner.id
                      ? {
                          ...c,
                          status: mapOperationalStateToDisplayStatus(runtimeDataOperationMode),
                          operationalState: runtimeDataOperationMode,
                          operationalData: nextOperationalData,
                        }
                      : c
                  )
                );
                patchRegistryCpsRef.current?.(owner, {
                  status: mapOperationalStateToDisplayStatus(runtimeDataOperationMode),
                  operationalState: runtimeDataOperationMode,
                  operationalData: nextOperationalData,
                });
              }
              return;
            }

            const payload = data || rawStr;

            setMqttData((prev) => {
              if (
                normalizeCpsId(owner?.id || owner?.cpsId) === 'cpslai2' &&
                isCpsLai2SnapshotEquivalent(prev[owner.id], data)
              ) return prev;
              return { ...prev, [owner.id]: payload };
            });

            if (data && typeof data === 'object') {
              const normalizedOwnerOperationMode = normalizeOperationMode(ownerForDataCheck);
              const fallbackOperationMode = isRuntimeOperationMode(normalizedOwnerOperationMode)
                ? normalizedOwnerOperationMode
                : null;
              const operationalDataPatch = {
                currentTemperature:
                  data?.CurrentTemperature ?? data?.currentTemperature ?? owner?.operationalData?.currentTemperature ?? null,
                currentRPM: data?.CurrentRPM ?? data?.currentRPM ?? owner?.operationalData?.currentRPM ?? null,
                currentTorque:
                  data?.CurrentTorque ?? data?.currentTorque ?? owner?.operationalData?.currentTorque ?? null,
                pieceCounter:
                  data?.PieceCounter ?? data?.pieceCounter ?? owner?.operationalData?.pieceCounter ?? null,
                cycleTimeMs:
                  data?.CycleTimeMs ?? data?.cycleTimeMs ?? owner?.operationalData?.cycleTimeMs ?? null,
                lastUpdate: normalizeSnapshotTimestamp(data?.ts ?? data?.timestamp) ?? Date.now(),
              };
              const cpsLai3PhysicalDerivation = isCpsLai3Data
                ? deriveCpsLai3PhysicalOperationMode({
                    cpsId: 'cpslai3',
                    evidence: telemetryDataRef.current.cpslai3,
                    communication: {
                      dataFresh: data?.communication?.dataFresh === true,
                    },
                  })
                : null;
              const nextOperationalData = isCpsLai1Data
                ? mergeNonStatusOperationalData(owner, operationalDataPatch)
                : isCpsLai2Data
                  ? {
                      ...(owner?.operationalData || {}),
                      ...operationalDataPatch,
                      operationMode: getCpsLai2PhysicalOperationMode(
                        telemetryDataRef.current.cpslai2,
                        true
                      ),
                    }
                  : isCpsLai3Data
                    ? {
                        ...mergeNonStatusOperationalData(owner, operationalDataPatch),
                        operationMode: cpsLai3PhysicalDerivation?.valid
                          ? cpsLai3PhysicalDerivation.operationMode
                          : 'UNKNOWN',
                        physicalModeEvidence: telemetryDataRef.current.cpslai3,
                        physicalModeCommunication: {
                          dataFresh: data?.communication?.dataFresh === true,
                        },
                        physicalModeDerivation: cpsLai3PhysicalDerivation,
                        operationModeRaw:
                          data?.operationModeRaw ?? owner?.operationalData?.operationModeRaw ?? null,
                        operationModeSemanticStatus:
                          data?.operationModeSemanticStatus ??
                          owner?.operationalData?.operationModeSemanticStatus ??
                          'PENDING',
                      }
                : {
                    ...(owner?.operationalData || {}),
                    ...operationalDataPatch,
                    operationMode: runtimeDataOperationMode ?? fallbackOperationMode,
                  };

              setAddedCPS((prev) =>
                prev.map((c) =>
                  c.id === owner.id
                    ? isCpsLai1Data
                      ? {
                          ...c,
                          operationalData: mergeNonStatusOperationalData(c, operationalDataPatch),
                        }
                      : isCpsLai2Data
                        ? {
                            ...c,
                            operationalData: {
                              ...(c?.operationalData || {}),
                              ...nextOperationalData,
                            },
                          }
                        : isCpsLai3Data
                          ? {
                              ...c,
                              operationalData: {
                                ...(c?.operationalData || {}),
                                ...nextOperationalData,
                              },
                            }
                      : {
                        ...c,
                        status: mapOperationalStateToDisplayStatus(nextOperationalData.operationMode),
                        operationalState: canonicalOperationMode(nextOperationalData.operationMode),
                        operationalData: nextOperationalData,
                        }
                    : c
                )
              );
              patchRegistryCpsRef.current?.(
                owner,
                isCpsLai1Data
                  ? { operationalData: operationalDataPatch }
                  : isCpsLai2Data
                    ? { operationalData: nextOperationalData }
                    : isCpsLai3Data
                      ? { operationalData: nextOperationalData }
                    : {
                      status: mapOperationalStateToDisplayStatus(nextOperationalData.operationMode),
                      operationalState: canonicalOperationMode(nextOperationalData.operationMode),
                      operationalData: nextOperationalData,
                    }
              );
            }
            return;
          }

          if (isAlarm) {
            const alarm = safeParseJson(message) || { raw: rawStr };
            const ts = alarm?.ts || Date.now();
            const alertObj = {
              id: `${owner.id}-alarm-${ts}`,
              cpsId: owner.id,
              cpsName: owner.nome,
              component: alarm?.component || alarm?.source || 'alarm',
              severity: alarm?.severity || 'medium',
              timestamp: new Date(ts).toISOString(),
              raw: alarm,
            };
            setAlerts((prev) => [alertObj, ...prev].slice(0, 200));
          }
        });

        client.on('error', (err) => {
          pushMqttLog(`[MQTT_ERROR] ${err?.message || err}`);
        });
      } catch (err) {
        pushMqttLog(`[MQTT_BOOT_ERROR] ${err?.message || err}`);
      }
    };

    start();

    return () => {
      isDisposed = true;
      if (client) {
        try {
          pushMqttLog('[MQTT_UNSUBSCRIBE] cleanup -> ending client connection');
          setMqttClient(null);
          client.end(true);
        } catch {
          // noop
        }
      }
    };
  }, [persistPlugEvent, rememberOperationMode, withRememberedOperationMode]);

  useEffect(() => {
    if (!mqttClient) return;
    const dynamicSubs = Array.from(
      new Set(
        availableCPS
          .flatMap((cps) => buildSubscriptionTopicsForCps(cps))
          .filter(isValidMqttTopic)
      )
    );
    if (!dynamicSubs.length) return;
    setLog((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        message: `[MQTT_SUBSCRIBE] dynamic effect -> ${dynamicSubs.length} topics`,
      },
    ]);
    mqttClient.subscribe(dynamicSubs, (err) => {
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: err
            ? `[MQTT_SUBSCRIBE_ERROR] dynamic effect (${err?.message || err})`
            : `[MQTT_SUBSCRIBE_OK] dynamic effect`,
        },
      ]);
    });

    return () => {
      if (!mqttClient || !dynamicSubs.length) return;
      setLog((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          message: `[MQTT_UNSUBSCRIBE] dynamic effect -> ${dynamicSubs.length} topics`,
        },
      ]);
      mqttClient.unsubscribe(dynamicSubs, (err) => {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: err
              ? `[MQTT_UNSUBSCRIBE_ERROR] dynamic effect (${err?.message || err})`
              : `[MQTT_UNSUBSCRIBE_OK] dynamic effect`,
          },
        ]);
      });
    };
  }, [mqttClient, availableCPS]);

  const addCPS = useCallback(
    async (nameOrId) => {
      const key = String(nameOrId || '').toLowerCase();
      const cps =
        registry[key] ||
        Object.values(registry).find(
          (item) => item?.id === key || String(item?.nome || '').toLowerCase() === key
        );

      if (!cps) {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            message: `[PLAY_ERROR] CPS not found: ${nameOrId}`,
          },
        ]);
        return false;
      }

      const lifecycleCandidate = cps;

      if (
        isPhysicalCps(lifecycleCandidate) &&
        !canTransitionCpsLai1Lifecycle(cpsLai1CanonicalLifecycleRef.current, 'play')
      ) return false;

      const governanceGate = await requestLifecyclePlayGate(lifecycleCandidate);
      if (!governanceGate?.ok) {
        await refreshGovernanceProfile(lifecycleCandidate.id);
        return false;
      }
      const activeProfile = await refreshGovernanceProfile(lifecycleCandidate.id);
      const governedCps = governanceWithProfile(lifecycleCandidate, activeProfile || {
        profileId: governanceGate.profileId,
        profileVersion: governanceGate.profileVersion,
        status: governanceGate.governanceStatus,
        approvedAt: governanceGate.approvedAt,
        approvedBy: governanceGate.approvedBy,
        plugCycleStatus: 'ACTIVE',
      });

      if (addedCPSRef.current.some((item) => item.id === governedCps.id)) return true;

      const next = {
        ...governedCps,
        status: mapOperationalStateToDisplayStatus('running'),
        operationalState: 'running',
        lifecycle: lifecycleWithPhase(governedCps, 'play'),
        lifecyclePhase: 'play',
        globalState: {
          ...(governedCps.globalState || {}),
          state: 'running',
          status: 'running',
          playEnabled: true,
          lastUpdate: Date.now(),
        },
        operationalData: operationalDataForAcsmState(governedCps, 'running'),
      };

      rememberOperationMode(governedCps, 'running');
      setAddedCPS((prev) => [...prev, next]);
      patchRegistryCps(governedCps, {
        status: mapOperationalStateToDisplayStatus('running'),
        operationalState: 'running',
        lifecycle: next.lifecycle,
        lifecyclePhase: 'play',
        globalState: next.globalState,
        operationalData: next.operationalData,
      });
      publishLifecycleCommand(governedCps, 'play');
      return true;
    },
    [
      patchRegistryCps,
      publishLifecycleCommand,
      refreshGovernanceProfile,
      requestLifecyclePlayGate,
      registry,
      rememberOperationMode,
    ]
  );

  const removeCPS = useCallback((idOrName) => {
    const normalized = String(idOrName || '').toLowerCase();
    const cps = Object.values(registryRef.current || {}).find(
      (item) =>
        item?.id === normalized || String(item?.nome || '').toLowerCase() === normalized
    );
    if (!cps) return false;

    setAddedCPS((prev) =>
      prev.filter(
        (c) => c.id !== normalized && String(c.nome || '').toLowerCase() !== normalized
      )
    );
    patchRegistryCps(cps, {
      lifecycle: lifecycleWithPhase(cps, 'unplug'),
      lifecyclePhase: 'unplug',
    });
    publishCpsLai1LifecyclePhase(cps, 'unplug');
    return true;
  }, [patchRegistryCps, publishCpsLai1LifecyclePhase]);

 const startCPSById = useCallback(
  async (id) => {
    const cps = Object.values(registryRef.current || {}).find((item) => item?.id === id);
    if (!cps) return false;
    const lifecycleCandidate = cps;

    if (
      isPhysicalCps(lifecycleCandidate) &&
      !canTransitionCpsLai1Lifecycle(cpsLai1CanonicalLifecycleRef.current, 'play')
    ) return false;

    const governanceGate = await requestLifecyclePlayGate(lifecycleCandidate);
    if (!governanceGate?.ok) {
      await refreshGovernanceProfile(lifecycleCandidate.id);
      return false;
    }
    const activeProfile = await refreshGovernanceProfile(lifecycleCandidate.id);
    const governedCps = governanceWithProfile(lifecycleCandidate, activeProfile || {
      profileId: governanceGate.profileId,
      profileVersion: governanceGate.profileVersion,
      status: governanceGate.governanceStatus,
      approvedAt: governanceGate.approvedAt,
      approvedBy: governanceGate.approvedBy,
      plugCycleStatus: 'ACTIVE',
    });

    publishLifecycleCommand(governedCps, 'play');
    rememberOperationMode(governedCps, 'running');

    setAddedCPS((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              status: mapOperationalStateToDisplayStatus('running'),
              operationalState: 'running',
              lifecycle: lifecycleWithPhase(c, 'play'),
              lifecyclePhase: 'play',
              globalState: {
                ...(c.globalState || {}),
                state: 'running',
                status: 'running',
                playEnabled: true,
                lastUpdate: Date.now(),
              },
              governanceProfile: governedCps.governanceProfile,
              governanceStatus: governedCps.governanceStatus,
              operationalData: operationalDataForAcsmState(c, 'running'),
            }
          : c
      )
    );

    patchRegistryCps(governedCps, {
      status: mapOperationalStateToDisplayStatus('running'),
      operationalState: 'running',
      lifecycle: lifecycleWithPhase(governedCps, 'play'),
      lifecyclePhase: 'play',
      governanceProfile: governedCps.governanceProfile,
      governanceStatus: governedCps.governanceStatus,
      globalState: {
        ...(governedCps.globalState || {}),
        state: 'running',
        status: 'running',
        playEnabled: true,
        lastUpdate: Date.now(),
      },
      operationalData: operationalDataForAcsmState(governedCps, 'running'),
    });

    return true;
  },
  [
    publishLifecycleCommand,
    patchRegistryCps,
    refreshGovernanceProfile,
    requestLifecyclePlayGate,
    rememberOperationMode,
  ]
);

  const stopCPSById = useCallback(
  (id) => {
    const cps = Object.values(registryRef.current || {}).find((item) => item?.id === id);
    if (!cps) return false;

    publishLifecycleCommand(cps, 'stop');
    rememberOperationMode(cps, 'stopped');

    // Nao remove mais da Play ao parar; apenas atualiza o estado.
    setAddedCPS((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              status: mapOperationalStateToDisplayStatus('stopped'),
              operationalState: 'stopped',
              lifecycle: lifecycleWithPhase(c, 'play'),
              lifecyclePhase: 'play',
              globalState: {
                ...(c.globalState || {}),
                state: 'stopped',
                status: 'stopped',
                playEnabled: false,
                lastUpdate: Date.now(),
              },
              operationalData: operationalDataForAcsmState(c, 'stopped'),
            }
          : c
      )
    );

    patchRegistryCps(cps, {
      status: mapOperationalStateToDisplayStatus('stopped'),
      operationalState: 'stopped',
      lifecycle: lifecycleWithPhase(cps, 'play'),
      lifecyclePhase: 'play',
      globalState: {
        ...(cps.globalState || {}),
        state: 'stopped',
        status: 'stopped',
        playEnabled: false,
        lastUpdate: Date.now(),
      },
      operationalData: operationalDataForAcsmState(cps, 'stopped'),
    });

    return true;
  },
  [publishLifecycleCommand, patchRegistryCps, rememberOperationMode]
);

  const unplugCPS = useCallback(
    async (id) => {
      const normalized = normalizeCpsId(id);
      const cps = Object.values(registryRef.current || {}).find(
        (item) =>
          normalizeCpsId(item?.id || item?.cpsId || item?.topic) === normalized ||
          String(item?.nome || '').toLowerCase() === String(id || '').toLowerCase()
      );
      if (!cps) {
        throw new Error(`CPS not found for Unplug: ${id || '(empty id)'}`);
      }

      const payload = {
        cpsId: cps.id,
        cpsName: cps.nome,
        baseTopic: cps.topic,
        type: 'unplug_request',
        reason: 'manual_unplug',
        summary: `Manual unplug requested by ${ACTIVE_ACSM.code}.`,
        ts: Date.now(),
      };

      const lifecycleResponse = await fetch('/api/acsm/plug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          lifecycleTransition: {
            cpsId: cps.id,
            phase: 'unplug',
            timestamp: new Date(payload.ts).toISOString(),
          },
        }),
      });
      const lifecycleResult = await lifecycleResponse.json().catch(() => null);
      if (!lifecycleResponse.ok || lifecycleResult?.ok !== true) {
        throw new Error(lifecycleResult?.error || lifecycleResult?.reason || 'ACSM Unplug transition failed.');
      }

      publishUnplugNotificationIfAvailable({
        client: mqttClient,
        topic: LIFECYCLE_UNPLUG_REQUEST_TOPIC,
        payload,
        onSkipped: (reason, error) => {
        setLog((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
              message: `${reason}. LIFECYCLE_UNPLUG = SUCCESS.${error ? ` ${error?.message || error}` : ''}`,
          },
        ]);
        },
      });

      void persistPlugEvent({
        id: `${cps.id}-unplug-${payload.ts}`,
        eventType: 'UNPLUG',
        cpsId: cps.id,
        cpsName: cps.nome,
        topic: cps.topic,
        message: payload.summary,
        details: { reason: payload.reason, source: ACTIVE_ACSM.code },
        ts: payload.ts,
      });

      rememberOperationMode(cps, 'unplugged');
      setAddedCPS((prev) =>
        prev.filter((c) => c.id !== normalized && String(c.nome || '').toLowerCase() !== normalized)
      );
      patchRegistryCps(cps, {
        status: mapOperationalStateToDisplayStatus('unplugged'),
        operationalState: 'unplugged',
        lifecycle: lifecycleWithPhase(cps, 'unplug'),
        lifecyclePhase: 'unplug',
        globalState: {
          ...(cps.globalState || {}),
          state: 'unplugged',
          status: 'unplugged',
          playEnabled: false,
          summary: `Manual unplug requested by ${ACTIVE_ACSM.code}.`,
          lastUpdate: Date.now(),
        },
        operationalData: operationalDataWithMode(cps, 'unplugged'),
      });
      publishCpsLai1LifecyclePhase(cps, 'unplug');
      return true;
    },
    [
      mqttClient,
      patchRegistryCps,
      persistPlugEvent,
      publishCpsLai1LifecyclePhase,
      rememberOperationMode,
    ]
  );

  const toggleCPSStatus = useCallback(
    (id) => {
      const running = addedCPSRef.current.some((c) => c.id === id);
      return running ? stopCPSById(id) : startCPSById(id);
    },
    [startCPSById, stopCPSById]
  );

  const getMQTTOperations = useCallback(() => {
    return addedCPS
      .map((cps) => {
        const currentData = mqttData[cps.id];
        const feats = (cps.funcionalidades || [])
          .map((f) => `${sanitizeManagedText(f.nome || f.key)}:${sanitizeManagedText(f.statusAtual || '-')}`)
          .join(', ');
        const featLine = feats ? ` - Feat: [${feats}]` : '';

        if (String(cps.status).toLowerCase() !== 'rodando') {
          return `${cps.nome} (${cps.server}/${cps.topic}): Stopped${featLine}`;
        }

        if (currentData && typeof currentData === 'object') {
          return `${cps.nome} (${cps.server}/${cps.topic}): ${JSON.stringify(currentData)}${featLine}`;
        }

        const last = currentData || 'Waiting.';
        return `${cps.nome} (${cps.server}/${cps.topic}): Last Msg: ${last}${featLine}`;
      })
      .join('\n\n');
  }, [addedCPS, mqttData]);

  const acknowledgeAlert = (idOrCorrelation) => {
    setAlerts((prev) =>
      prev.filter((a) => a.id !== idOrCorrelation && a.correlation_id !== idOrCorrelation)
    );

    setLog((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        message: `[INFO] Alert acknowledged (${idOrCorrelation}).`,
      },
    ]);
  };

  const clearAlerts = () => {
    setAlerts([]);
    setLog((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        message: `[INFO] Alerts cleared.`,
      },
    ]);
  };

  const clearLog = () => {
    setLog([
      {
        time: new Date().toLocaleTimeString(),
        message: '[INFO] Log cleared.',
      },
    ]);
  };

  return (
    <CPSContext.Provider
      value={{
        acsmConfig,
        availableCPSNames,
        availableCPS,
        addedCPS,
        playPhaseCPS,
        getCanonicalOperationalState,
        log,
        registerCPS,
        plugCPS,
        addCPS,
        removeCPS,
        startCPSById,
        stopCPSById,
        unplugCPS,
        toggleCPSStatus,
        clearLog,
        alerts,
        acknowledgeAlert,
        clearAlerts,
        governanceProfiles,
        pendingGovernanceActions,
        refreshGovernanceProfile,
        updateGovernanceProfile,
        approveGovernanceProfile,
        rejectGovernanceProfile,
        checkGovernanceAction,
        decidePendingGovernanceAction,
        cpsAnalytics,
        aiEnrichedAnalyticsTopic: AI_ENRICHED_ANALYTICS_TOPIC,
        setCpsAnalytics,
        getMQTTOperations,
        ingestionBuffer,
        systemAnalytics,
        stableSystemAnalytics,
        multiAcsmInputs,
        coordinatorSnapshots,
        level3RuntimeStatus,
        supplyChainCoordinator,
        supplyChainPackage,
        supplyChainFeedback,
        localAdaptiveIntelligence,
        serviceAdaptiveIntelligence,
        cpsAdaptiveIntelligence,
        level3LastPublishAt,
        level3AutoPublishEnabled,
        setLevel3AutoPublishEnabled,
        mqttConnected: Boolean(mqttClient?.connected),
        telemetryData,
        telemetryCommunication,
        runSystemAnalytics,
        publishToCoordinator,
        buildLevel3KnowledgePackage,
        publishLevel3KnowledgePackage,
        openCoordinatorDashboard,
        loadLevel3PublisherPreferences,
        saveLevel3PublisherPreferences,
        getCoordinatorOutput,
        getSupplyChainCoordinator,
        getKnowledgeStore,
        exportSystemSnapshot,
      }}
    >
      {children}
    </CPSContext.Provider>
  );
};












