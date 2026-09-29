'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Radio, Send, ShieldAlert } from 'lucide-react';
import { CPSProvider, useCPSContext } from '../../context/CPSContext';
import GenerativeAIInterpretationPanel from '../../components/GenerativeAIInterpretationPanel';
import {
  appendCognitiveSnapshot,
  createCognitiveSnapshot,
  getLatestCognitiveSnapshot,
  summarizeCognitiveMemory,
} from '../../services/memory/hierarchicalCognitiveMemoryService';

const SUPPLYCHAIN_REASONING_TOPIC = 'supplychain/reasoning';
const AUTO_PUBLISH_DEBOUNCE_MS = 2500;

const formatPercent = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '-';
};

const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

const formatText = (value, fallback = '-') => {
  const text = String(value || '').trim();
  return text || fallback;
};

const getComparablePayload = (payload) => {
  if (!payload) return null;
  const { ts, timestamp, ...stablePayload } = payload;
  return stablePayload;
};

const hasObjectContent = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

const stripVolatileFields = (value) => {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !['timestamp', 'ts', 'generatedAt', 'lastUpdate', 'receivedAt'].includes(key)
      )
      .map(([key, item]) => [key, stripVolatileFields(item)])
  );
};

const hashSignature = (value) => {
  const text = JSON.stringify(stripVolatileFields(value || {}));
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return `hcm_${Math.abs(hash)}`;
};

const cardStyle = {
  border: '1px solid rgba(148, 163, 184, 0.24)',
  background: '#ffffff',
  borderRadius: 8,
  padding: 18,
  boxShadow: '0 18px 42px rgba(15, 23, 42, 0.07)',
};

const buttonBaseStyle = {
  border: 0,
  borderRadius: 8,
  padding: '12px 16px',
  fontWeight: 800,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  minHeight: 44,
};

function KnowledgePublisherContent() {
  const {
    mqttConnected,
    buildLevel3KnowledgePackage,
    publishLevel3KnowledgePackage,
    level3LastPublishAt,
    level3AutoPublishEnabled,
    setLevel3AutoPublishEnabled,
    openCoordinatorDashboard,
    saveLevel3PublisherPreferences,
  } = useCPSContext();

  const [publishFeedback, setPublishFeedback] = useState('');
  const [level3MemorySamples, setLevel3MemorySamples] = useState(0);
  const lastAutoPayloadSignatureRef = useRef('');
  const lastLevel3SnapshotSignatureRef = useRef('');
  const autoPublishTimerRef = useRef(null);

  const previewPayload = useMemo(
    () => buildLevel3KnowledgePackage('acsm1'),
    [buildLevel3KnowledgePackage]
  );

  const stablePayloadSignature = useMemo(
    () => JSON.stringify(getComparablePayload(previewPayload)),
    [previewPayload]
  );
  const level3CognitiveSignature = useMemo(
    () => (hasObjectContent(previewPayload) ? hashSignature(previewPayload) : ''),
    [previewPayload]
  );

  const handlePublishNow = useCallback(() => {
    const result = publishLevel3KnowledgePackage('acsm1');
    if (result) {
      if (mqttConnected) {
        lastAutoPayloadSignatureRef.current = stablePayloadSignature;
        setPublishFeedback('Knowledge package published to supplychain/reasoning.');
        return;
      }
      setPublishFeedback('MQTT is disconnected. Package updated locally and will be ready to publish.');
      return;
    }
    setPublishFeedback('Publisher unavailable. The package was not sent.');
  }, [mqttConnected, publishLevel3KnowledgePackage, stablePayloadSignature]);

  const handleAutoPublishChange = useCallback(
    (event) => {
      const enabled = event.target.checked;
      setLevel3AutoPublishEnabled(enabled);
      saveLevel3PublisherPreferences({
        autoPublishEnabled: enabled,
        lastPayload: previewPayload,
      });
    },
    [previewPayload, saveLevel3PublisherPreferences, setLevel3AutoPublishEnabled]
  );

  useEffect(() => {
    if (!level3AutoPublishEnabled || !mqttConnected || !previewPayload || !stablePayloadSignature) {
      return undefined;
    }
    if (lastAutoPayloadSignatureRef.current === stablePayloadSignature) return undefined;

    autoPublishTimerRef.current = window.setTimeout(() => {
      const result = publishLevel3KnowledgePackage('acsm1');
      if (result) {
        lastAutoPayloadSignatureRef.current = stablePayloadSignature;
        setPublishFeedback('Auto publish sent the latest Level 3 package.');
      }
    }, AUTO_PUBLISH_DEBOUNCE_MS);

    return () => {
      if (autoPublishTimerRef.current) {
        window.clearTimeout(autoPublishTimerRef.current);
      }
    };
  }, [
    level3AutoPublishEnabled,
    mqttConnected,
    previewPayload,
    publishLevel3KnowledgePackage,
    stablePayloadSignature,
  ]);

  useEffect(() => {
    if (!level3CognitiveSignature || !hasObjectContent(previewPayload)) return;
    if (lastLevel3SnapshotSignatureRef.current === level3CognitiveSignature) return;

    const latestSnapshot = getLatestCognitiveSnapshot('level3', 'acsm1_service');
    if (latestSnapshot?.metadata?.traceId === level3CognitiveSignature) {
      lastLevel3SnapshotSignatureRef.current = level3CognitiveSignature;
      setLevel3MemorySamples(summarizeCognitiveMemory('level3', 'acsm1_service').samples);
      return;
    }

    lastLevel3SnapshotSignatureRef.current = level3CognitiveSignature;

    const snapshot = createCognitiveSnapshot({
      level: 'level3',
      source: 'acsm1_service',
      target: 'supply_chain_coordinator',
      observed: {
        publisher: previewPayload.publisher,
        topic: previewPayload.topic || SUPPLYCHAIN_REASONING_TOPIC,
        messageType: previewPayload.messageType,
      },
      knowledge: {
        executiveSummary: previewPayload.executiveSummary,
        globalOEE: previewPayload.globalOEE,
        criticalCPS: previewPayload.criticalCPS,
        globalCriticalityRanking: previewPayload.globalCriticalityRanking,
        acsmCriticalityRanking: previewPayload.acsmCriticalityRanking,
        multiAcsmInputs: previewPayload.multiAcsmInputs,
      },
      learning: {
        level3LearningModel: previewPayload.level3LearningModel,
        learningConsensus: previewPayload.learningConsensus,
        dominantLearningPattern:
          previewPayload.dominantLearningPattern || previewPayload.learningPattern,
      },
      reasoning: {
        globalExecutiveReasoning: previewPayload.globalExecutiveReasoning,
        globalSystemEvidence: previewPayload.globalSystemEvidence,
        globalSystemCausality: previewPayload.globalSystemCausality,
        recommendation: previewPayload.recommendation,
      },
      prediction: {
        globalSystemForecast: previewPayload.globalSystemForecast,
        expectedOEE:
          previewPayload.expectedOEE || previewPayload.globalSystemForecast?.expectedOEE,
        risk: previewPayload.riskLevel,
      },
      decision: {},
      feedback: {},
      effectiveness: {},
      metadata: {
        originTopic: SUPPLYCHAIN_REASONING_TOPIC,
        relatedTopics: [
          'acsm1/level2/intelligence',
          'acsm2/level2/intelligence',
          'acsm3/level2/intelligence',
        ],
        inputMessageTypes: ['acsm_level2_intelligence', 'level3_knowledge_package'],
        confidence: previewPayload.confidence,
        riskLevel: previewPayload.riskLevel,
        window: previewPayload.window || {},
        traceId: level3CognitiveSignature,
      },
    });

    const memory = appendCognitiveSnapshot('level3', 'acsm1_service', snapshot);
    setLevel3MemorySamples(memory.length);
  }, [level3CognitiveSignature, previewPayload]);

  useEffect(() => {
    try {
      setLevel3MemorySamples(summarizeCognitiveMemory('level3', 'acsm1_service').samples);
    } catch {
      setLevel3MemorySamples(0);
    }
  }, []);

  const lastPublishLabel = formatDateTime(level3LastPublishAt);
  const riskLevel = formatText(previewPayload?.riskLevel, 'unknown');
  const trend = formatText(previewPayload?.trend, 'unknown');
  const criticalCps =
    previewPayload?.criticalCPS?.cpsId || previewPayload?.criticalCPS?.cpsName || '-';
  const jsonPreview = JSON.stringify(previewPayload, null, 2);

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#f5f7fb',
        color: '#0f172a',
      }}
    >
      <section
        style={{
          background:
            'linear-gradient(135deg, #07111f 0%, #12213a 48%, #0b3b4a 100%)',
          color: '#f8fafc',
          padding: '42px 24px 34px',
          boxShadow: '0 24px 70px rgba(15, 23, 42, 0.26)',
        }}
      >
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 20,
              alignItems: 'flex-start',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ maxWidth: 760 }}>
              <div
                style={{
                  color: '#7dd3fc',
                  fontSize: 13,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                }}
              >
                Level 3 Supply Chain Integration
              </div>
              <h1
                style={{
                  margin: '12px 0 10px',
                  fontSize: 46,
                  lineHeight: 1.05,
                  fontWeight: 900,
                  letterSpacing: 0,
                }}
              >
                ACSM-1 Knowledge Publisher
              </h1>
              <p
                style={{
                  margin: 0,
                  color: '#cbd5e1',
                  fontSize: 17,
                  lineHeight: 1.65,
                  maxWidth: 720,
                }}
              >
                Publishes the consolidated Level 3 knowledge package from ACSM1 to the
                Supply Chain Coordinator on the MQTT topic supplychain/reasoning.
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
              }}
            >
              <span
                style={{
                  padding: '9px 12px',
                  borderRadius: 999,
                  background: mqttConnected ? 'rgba(34, 197, 94, 0.16)' : 'rgba(248, 113, 113, 0.16)',
                  border: mqttConnected
                    ? '1px solid rgba(134, 239, 172, 0.34)'
                    : '1px solid rgba(252, 165, 165, 0.34)',
                  color: mqttConnected ? '#bbf7d0' : '#fecaca',
                  fontWeight: 800,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Radio size={16} />
                MQTT {mqttConnected ? 'connected' : 'disconnected'}
              </span>
              <span
                style={{
                  padding: '9px 12px',
                  borderRadius: 999,
                  background: 'rgba(255, 255, 255, 0.11)',
                  border: '1px solid rgba(255, 255, 255, 0.18)',
                  color: '#e0f2fe',
                  fontWeight: 800,
                }}
              >
                Trend: {trend}
              </span>
              <span
                style={{
                  padding: '9px 12px',
                  borderRadius: 999,
                  background: 'rgba(251, 191, 36, 0.14)',
                  border: '1px solid rgba(251, 191, 36, 0.28)',
                  color: '#fde68a',
                  fontWeight: 800,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <ShieldAlert size={16} />
                Risk: {riskLevel}
              </span>
            </div>
          </div>
        </div>
      </section>

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px' }}>
        <section
          style={{
            ...cardStyle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            marginBottom: 18,
          }}
        >
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handlePublishNow}
              style={{
                ...buttonBaseStyle,
                background: '#0f766e',
                color: '#ffffff',
                boxShadow: '0 12px 28px rgba(15, 118, 110, 0.22)',
              }}
            >
              <Send size={18} />
              Publish Now
            </button>
            <button
              type="button"
              onClick={openCoordinatorDashboard}
              style={{
                ...buttonBaseStyle,
                background: '#111827',
                color: '#ffffff',
                boxShadow: '0 12px 28px rgba(17, 24, 39, 0.18)',
              }}
            >
              <ArrowUpRight size={18} />
              Open Coordinator Dashboard
            </button>
          </div>

          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              color: '#334155',
              fontWeight: 800,
              cursor: 'pointer',
              minHeight: 44,
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(level3AutoPublishEnabled)}
              onChange={handleAutoPublishChange}
              style={{ width: 18, height: 18, accentColor: '#0f766e' }}
            />
            Auto publish
          </label>

          {publishFeedback ? (
            <div
              style={{
                flexBasis: '100%',
                color: '#0f766e',
                fontSize: 14,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Check size={16} />
              {publishFeedback}
            </div>
          ) : null}
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <div style={cardStyle}>
            <div style={{ color: '#64748b', fontSize: 13, fontWeight: 800 }}>MQTT Topic</div>
            <div style={{ marginTop: 8, fontSize: 17, fontWeight: 900 }}>
              {SUPPLYCHAIN_REASONING_TOPIC}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={{ color: '#64748b', fontSize: 13, fontWeight: 800 }}>Global OEE</div>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 900 }}>
              {formatPercent(previewPayload?.globalOEE)}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={{ color: '#64748b', fontSize: 13, fontWeight: 800 }}>Critical CPS</div>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 900 }}>
              {formatText(criticalCps)}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={{ color: '#64748b', fontSize: 13, fontWeight: 800 }}>Last Publish</div>
            <div style={{ marginTop: 8, fontSize: 17, fontWeight: 900 }}>
              {lastPublishLabel}
            </div>
          </div>
        </section>

        <GenerativeAIInterpretationPanel
          level="level3"
          contextType="executive"
          knowledgePackage={previewPayload || {}}
          language="en"
          outputType="summary"
          title="Generative AI Interpretation - Level 3 Executive Intelligence"
        />

        <div style={{ color: '#64748b', fontSize: 12, fontWeight: 800, marginBottom: 12 }}>
          Cognitive Memory: {level3MemorySamples} snapshots
        </div>

        <section style={{ ...cardStyle, padding: 22 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
              marginBottom: 16,
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 24, letterSpacing: 0 }}>
                Knowledge package preview
              </h2>
              <div style={{ marginTop: 6, color: '#64748b', fontWeight: 700 }}>
                ACSM1 Level 3 consolidated payload
              </div>
            </div>
            <div style={{ color: '#475569', fontWeight: 800 }}>
              Publisher: {previewPayload?.publisher?.acsmId || 'acsm1'} /{' '}
              {previewPayload?.publisher?.level || 'level3'}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: 16,
                background: '#f8fafc',
              }}
            >
              <div style={{ color: '#64748b', fontSize: 13, fontWeight: 900 }}>
                Executive summary
              </div>
              <p style={{ margin: '8px 0 0', lineHeight: 1.6, color: '#1f2937' }}>
                {formatText(previewPayload?.executiveSummary)}
              </p>
            </div>

            <div
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: 16,
                background: '#f8fafc',
              }}
            >
              <div style={{ color: '#64748b', fontSize: 13, fontWeight: 900 }}>
                Dominant learning pattern
              </div>
              <div style={{ marginTop: 8, fontSize: 22, fontWeight: 900 }}>
                {formatText(previewPayload?.learningPattern)}
              </div>
              <div style={{ marginTop: 8, color: '#475569', lineHeight: 1.5 }}>
                {formatText(previewPayload?.learningConsensus)}
              </div>
            </div>
          </div>

          <pre
            style={{
              margin: 0,
              padding: 18,
              overflowX: 'auto',
              maxHeight: 560,
              borderRadius: 8,
              background: '#0b1020',
              color: '#dbeafe',
              border: '1px solid #1e293b',
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            {jsonPreview}
          </pre>
        </section>
      </div>
    </main>
  );
}

export default function KnowledgePublisherPage() {
  return (
    <CPSProvider acsmId="acsm1">
      <KnowledgePublisherContent />
    </CPSProvider>
  );
}
