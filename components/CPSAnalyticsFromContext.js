'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCPSContext } from '../context/CPSContext';
import CPSDashboard from './CPSDashboard';
import GenerativeAIInterpretationPanel from './GenerativeAIInterpretationPanel';
import {
  getActiveAcsmConfig,
  getManagedCpsIdsForAcsm,
  normalizeCpsId,
} from '../lib/acsm/config';
import { buildLevel1KnowledgePackage } from '../lib/ai/knowledgePackages';
import {
  appendCognitiveSnapshot,
  createCognitiveSnapshot,
  summarizeCognitiveMemory,
} from '../services/memory/hierarchicalCognitiveMemoryService';
import { sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';

const hasObjectContent = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

const hasMinimumLevel1Evidence = (analytics = {}, knowledgePackage = {}) =>
  knowledgePackage.oee !== undefined ||
  knowledgePackage.availability !== undefined ||
  hasObjectContent(analytics.oee) ||
  hasObjectContent(analytics.telemetry) ||
  hasObjectContent(analytics.rawTelemetry);

const buildStableSignature = (value) => JSON.stringify(value);

export default function CPSAnalyticsFromContext({
  cpsId = getActiveAcsmConfig().defaultCpsId,
  title = 'OEE & Learning',
}) {
  const {
    acsmConfig,
    availableCPS = [],
    addedCPS = [],
    playPhaseCPS = [],
    cpsAnalytics = {},
    cpsAdaptiveIntelligence = {},
    getCanonicalOperationalState,
  } = useCPSContext();
  const lastLevel1SnapshotSignatureRef = useRef('');
  const [level1MemorySamples, setLevel1MemorySamples] = useState(0);
  const fallbackConfig = getActiveAcsmConfig();
  const activeConfig = acsmConfig?.id ? acsmConfig : fallbackConfig;
  const allowedCpsIds = getManagedCpsIdsForAcsm(activeConfig);
  const defaultCpsId = normalizeCpsId(activeConfig?.defaultCpsId || fallbackConfig.defaultCpsId);
  const normalizedRequestedCpsId = normalizeCpsId(cpsId);
  const effectiveCpsId = allowedCpsIds.includes(normalizedRequestedCpsId)
    ? normalizedRequestedCpsId
    : defaultCpsId;

  if (!allowedCpsIds.includes(normalizedRequestedCpsId)) {
    console.warn('[ACSM Analytics] CPSAnalyticsFromContext received an out-of-scope cpsId.', {
      requestedId: cpsId,
      normalizedRequestedId: normalizedRequestedCpsId,
      allowedCpsIds,
      defaultCpsId,
      resolvedCpsId: effectiveCpsId,
    });
  }

  const analytics = useMemo(
    () => cpsAnalytics[effectiveCpsId] || {},
    [cpsAnalytics, effectiveCpsId]
  );
  const adaptiveIntelligence = useMemo(
    () => cpsAdaptiveIntelligence?.[effectiveCpsId],
    [cpsAdaptiveIntelligence, effectiveCpsId]
  );
  const cps = useMemo(() => {
    const candidates = [...playPhaseCPS, ...addedCPS, ...availableCPS];
    return (
      candidates.find((item) => {
        const ids = [
          item?.id,
          item?.cpsId,
          item?.topic,
          item?.baseTopic,
          item?.lifecycle?.cpsId,
          item?.lifecycle?.baseTopic,
        ];
        return ids.some((id) => normalizeCpsId(id) === effectiveCpsId);
      }) || null
    );
  }, [addedCPS, availableCPS, effectiveCpsId, playPhaseCPS]);
  const hasData = Object.keys(analytics).length > 0;
  const safeTitle = sanitizeTextEncoding(title, { fallback: 'OEE & Learning' });
  const level1KnowledgePackage = useMemo(
    () =>
      buildLevel1KnowledgePackage({
        cpsId: effectiveCpsId,
        analytics,
        adaptiveIntelligence,
      }),
    [adaptiveIntelligence, analytics, effectiveCpsId]
  );
  const level1CognitiveSignature = useMemo(
    () =>
      hasMinimumLevel1Evidence(analytics, level1KnowledgePackage)
        ? buildStableSignature({
            cpsId: effectiveCpsId,
            knowledge: level1KnowledgePackage,
            lastUpdate: analytics?.lastUpdate || analytics?.oee?.ts || null,
          })
        : '',
    [analytics, effectiveCpsId, level1KnowledgePackage]
  );

  useEffect(() => {
    if (!level1CognitiveSignature) return;
    if (lastLevel1SnapshotSignatureRef.current === level1CognitiveSignature) return;
    lastLevel1SnapshotSignatureRef.current = level1CognitiveSignature;

    const oee = analytics?.oee || {};
    const learning = analytics?.learning || {};
    const reasoning = analytics?.reasoning || {};
    const evidence =
      analytics?.evidence ||
      learning?.basis ||
      analytics?.basis ||
      analytics?.timeSeriesFeatures?.quickSignals ||
      {};
    const source = effectiveCpsId;
    const confidence =
      level1KnowledgePackage.confidence ?? learning?.confidence ?? analytics?.confidence ?? null;
    const riskLevel =
      level1KnowledgePackage.riskLevel ?? analytics?.riskLevel ?? learning?.riskLevel ?? null;

    const snapshot = createCognitiveSnapshot({
      level: 'level1',
      source,
      target: activeConfig?.id || 'acsm',
      observed: {
        telemetry: analytics?.telemetry || analytics?.rawTelemetry || {},
        rawMetrics: {
          oee,
          statistics: analytics?.statistics || {},
        },
      },
      knowledge: {
        oee: level1KnowledgePackage.oee,
        availability: level1KnowledgePackage.availability,
        performance: level1KnowledgePackage.performance,
        quality: level1KnowledgePackage.quality,
        localAssessment: level1KnowledgePackage,
      },
      learning: {
        learningPattern: level1KnowledgePackage.learningPattern || learning?.type,
        trend: analytics?.trend || learning?.trend,
        driftScore: analytics?.driftScore || learning?.driftScore,
        anomalyScore: analytics?.anomalyScore || learning?.anomalyScore,
        confidence,
      },
      reasoning: {
        dominantLoss: level1KnowledgePackage.dominantLoss || reasoning?.dominantLoss,
        probableCause: reasoning?.probableCause,
        evidence,
        recommendation: level1KnowledgePackage.recommendation || reasoning?.recommendation,
      },
      prediction: {
        forecastOEE: level1KnowledgePackage.forecastOEE,
        expectedState: analytics?.expectedState || analytics?.predictedState,
        risk: riskLevel,
      },
      decision: {},
      feedback: {},
      effectiveness: {},
      metadata: {
        originTopic: `${source}/analytics`,
        relatedTopics: [`${source}/oee`, `${source}/learning`],
        inputMessageTypes: ['cps_oee', 'cps_learning'],
        confidence,
        riskLevel,
        window: analytics?.window || analytics?.statistics?.window || {},
      },
    });

    const memory = appendCognitiveSnapshot('level1', source, snapshot);
    setLevel1MemorySamples(memory.length);
  }, [
    activeConfig?.id,
    analytics,
    effectiveCpsId,
    level1CognitiveSignature,
    level1KnowledgePackage,
  ]);

  useEffect(() => {
    if (!effectiveCpsId) return;
    try {
      setLevel1MemorySamples(summarizeCognitiveMemory('level1', effectiveCpsId).samples);
    } catch {
      setLevel1MemorySamples(0);
    }
  }, [effectiveCpsId]);

  if (!hasData) {
    return (
      <div
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 24,
          padding: 24,
          background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
          boxShadow: '0 16px 40px rgba(15,23,42,0.06)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>ACSM Analytics</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a' }}>{safeTitle}</div>
            <div style={{ marginTop: 8, color: '#475569' }}>
              CPS ID: <strong>{effectiveCpsId}</strong>
            </div>
          </div>

          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '8px 14px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 800,
              color: '#92400e',
              background: '#fef3c7',
              border: '1px solid #fcd34d',
            }}
          >
            Waiting for MQTT
          </span>
        </div>

        <div style={{ color: '#475569', lineHeight: 1.8 }}>
          Awaiting MQTT analytics telemetry for the selected CPS.
        </div>

        <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: '#0f172a',
              color: '#e2e8f0',
              fontFamily: 'monospace',
            }}
          >
            {effectiveCpsId}/oee
          </div>
          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: '#0f172a',
              color: '#e2e8f0',
              fontFamily: 'monospace',
            }}
          >
            {effectiveCpsId}/learning
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12, display: 'grid', gap: 12 }}>
      <CPSDashboard
        cpsId={effectiveCpsId}
        cps={cps}
        analytics={analytics}
        adaptiveIntelligence={adaptiveIntelligence}
        getCanonicalOperationalState={getCanonicalOperationalState}
      />
      <GenerativeAIInterpretationPanel
        level="level1"
        contextType="operational"
        knowledgePackage={level1KnowledgePackage}
        language="en"
        outputType="summary"
        title="Generative AI Interpretation - Level 1 Operational Intelligence"
      />
      <div style={{ color: '#64748b', fontSize: 12, fontWeight: 800 }}>
        Cognitive Memory: {level1MemorySamples} snapshots
      </div>
    </div>
  );
}
