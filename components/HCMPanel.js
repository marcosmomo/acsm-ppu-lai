'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

const HCM_BLUE = '#2563eb';
const HCM_GREEN = '#16a34a';
const HCM_YELLOW = '#d97706';
const HCM_RED = '#dc2626';
const HCM_GRAY = '#64748b';

const getHcmApiBase = () => {
  const configured = process.env.NEXT_PUBLIC_HCM_API_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location.port && window.location.port !== '3000') {
    return 'http://localhost:3000/api/hcm';
  }
  return '/api/hcm';
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const text = (value, fallback = '-') => {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
};

const toNumberOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatPct = (value) => {
  const numeric = toNumberOrNull(value);
  if (numeric === null) return '-';
  return `${(numeric * 100).toFixed(1)}%`;
};

const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
};

const formatDuration = (start, end) => {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return '-';
  const totalSeconds = Math.max(0, Math.round((endTime - startTime) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

const prettyJson = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const compactJson = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '-';
  }
};

const latestEvent = (events, type) =>
  asArray(events)
    .filter((event) => event.eventType === type)
    .at(-1) || null;

const firstEvent = (events, type) =>
  asArray(events).find((event) => event.eventType === type) || null;

const getNested = (source, paths) => {
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const getLocalMetrics = (value) => {
  if (!value || typeof value !== 'object') return null;
  const source = value.metrics || value.globalOEE || value.oee || value.systemAnalytics?.globalOEE || value.analytics?.globalOEE || value;
  const availability = toNumberOrNull(source.availability);
  const performance = toNumberOrNull(source.performance);
  const quality = toNumberOrNull(source.quality);
  const oee = toNumberOrNull(source.oee ?? source.current ?? source.globalOEE ?? value.oee);
  if ([availability, performance, quality, oee].every((metric) => metric === null)) return null;
  return { availability, performance, quality, oee };
};

const metricGain = (before, after, key) => {
  const beforeValue = toNumberOrNull(before?.[key]);
  const afterValue = toNumberOrNull(after?.[key]);
  if (beforeValue === null || afterValue === null) return null;
  return afterValue - beforeValue;
};

const gainTone = (value) => {
  const numeric = toNumberOrNull(value);
  if (numeric === null) return HCM_GRAY;
  if (numeric > 0) return HCM_GREEN;
  if (numeric < 0) return HCM_RED;
  return HCM_GRAY;
};

const scoreDecision = (effectivenessItem) => {
  if (!effectivenessItem) return null;
  if (effectivenessItem.result === 'effective') return 100;
  if (effectivenessItem.result === 'partially_effective') return 60;
  if (effectivenessItem.result === 'ineffective') return 20;
  return null;
};

const statusTone = (status) => {
  if (status === 'open') return { bg: '#dbeafe', color: HCM_BLUE, border: '#bfdbfe' };
  if (status === 'closed') return { bg: '#dcfce7', color: HCM_GREEN, border: '#bbf7d0' };
  if (status === 'timeout') return { bg: '#fef3c7', color: HCM_YELLOW, border: '#fde68a' };
  return { bg: '#f1f5f9', color: '#334155', border: '#e2e8f0' };
};

const resultTone = (result) => {
  if (result === 'effective') return { bg: '#dcfce7', color: HCM_GREEN, border: '#bbf7d0' };
  if (result === 'partially_effective') return { bg: '#fef3c7', color: HCM_YELLOW, border: '#fde68a' };
  if (result === 'ineffective') return { bg: '#fee2e2', color: HCM_RED, border: '#fecaca' };
  return { bg: '#f1f5f9', color: '#334155', border: '#e2e8f0' };
};

const normalizeResult = (result) => text(result, 'unknown').replace(/_/g, ' ').toUpperCase();

const getOriginalKnowledge = (item) =>
  item?.originalKnowledge && typeof item.originalKnowledge === 'object' ? item.originalKnowledge : {};

const knowledgeText = (item) => {
  const original = getOriginalKnowledge(item);
  return text(
    original.pattern ||
      original.learning?.pattern ||
      original.learning?.learned ||
      original.reasoning?.dominantLoss ||
      original.dominantLoss ||
      original.reasoning?.probableCause ||
      original.probableCause ||
      original.learning?.state
  );
};

const knowledgeEvidence = (item) => {
  const original = getOriginalKnowledge(item);
  return (
    original.evidence ||
    original.learning?.evidence ||
    original.reasoning?.evidence ||
    original.reasoning?.supportingEvidence ||
    original.learning?.basis
  );
};

const knowledgeRecommendation = (item) => {
  const original = getOriginalKnowledge(item);
  return (
    original.recommendation ||
    original.reasoning?.recommendation ||
    original.learning?.recommendation ||
    '-'
  );
};

const summarizeExperience = ({ result, globalGain, availabilityGain, dominantLoss }) => {
  if (result === 'effective') {
    return 'This strategy consistently improved operational performance and should be preferred in future similar episodes.';
  }
  if (result === 'partially_effective') {
    return `This strategy produced limited improvement. Future similar episodes should monitor ${text(
      dominantLoss,
      'the dominant loss'
    )} before repeating the same action.`;
  }
  if (result === 'ineffective') {
    return 'This strategy did not improve the global OEE. Future episodes with similar conditions should consider another maintenance strategy.';
  }
  if (availabilityGain !== null) {
    return `This strategy changed availability by ${formatPct(availabilityGain)}; additional feedback is needed before reusing it.`;
  }
  if (globalGain !== null) {
    return `This strategy produced a global OEE gain of ${formatPct(globalGain)}; classification is still pending.`;
  }
  return 'No operational feedback has been recorded yet for this strategy.';
};

const cardStyle = {
  border: '1px solid #e2e8f0',
  borderRadius: 12,
  background: '#ffffff',
  padding: 16,
};

function Badge({ children, tone }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '5px 9px',
        borderRadius: 999,
        background: tone.bg,
        color: tone.color,
        border: `1px solid ${tone.border}`,
        fontSize: 11,
        fontWeight: 900,
        letterSpacing: 0.2,
      }}
    >
      {children}
    </span>
  );
}

function SectionHeader({ title, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h3 style={{ margin: 0, color: '#0f172a', fontSize: 16, fontWeight: 900 }}>{title}</h3>
      {action || null}
    </div>
  );
}

function FieldCard({ label, value, wide = false }) {
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        padding: 12,
        background: '#f8fafc',
        gridColumn: wide ? '1 / -1' : undefined,
        minWidth: 0,
      }}
    >
      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 900, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ color: '#0f172a', fontSize: 14, fontWeight: 800, wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  );
}

function MetricBar({ label, value, score = false }) {
  const numeric = toNumberOrNull(value);
  const barValue = score ? (numeric ?? 0) / 100 : Math.min(Math.abs(numeric ?? 0), 0.12) / 0.12;
  const color = score ? HCM_BLUE : gainTone(numeric);
  return (
    <div style={{ ...cardStyle, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ color: '#0f172a', fontSize: 13, fontWeight: 900 }}>
          <span style={{ color, marginRight: 6 }}>[+]</span>
          {label}
        </div>
        <div style={{ color, fontSize: 13, fontWeight: 900 }}>
          {score ? (numeric === null ? '-' : `${numeric}/100`) : formatPct(numeric)}
        </div>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
        <div
          style={{
            width: `${Math.max(0, Math.min(1, barValue)) * 100}%`,
            height: '100%',
            background: color,
          }}
        />
      </div>
    </div>
  );
}

function TinyButton({ children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: '1px solid #cbd5e1',
        background: '#ffffff',
        color: '#1d4ed8',
        borderRadius: 9,
        padding: '7px 10px',
        fontWeight: 900,
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      {children}
    </button>
  );
}

function RawBlock({ title, value }) {
  return (
    <details style={{ ...cardStyle, padding: 12 }}>
      <summary style={{ cursor: 'pointer', color: '#0f172a', fontWeight: 900 }}>{title}</summary>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          margin: '12px 0 0',
          color: '#334155',
          fontSize: 12,
          lineHeight: 1.45,
          maxHeight: 340,
          overflow: 'auto',
        }}
      >
        {prettyJson(value)}
      </pre>
    </details>
  );
}

function TimelineStep({ icon, title, status, summary, last = false }) {
  const active = status !== 'missing';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr', columnGap: 12 }}>
      <div style={{ display: 'grid', justifyItems: 'center' }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 999,
            display: 'grid',
            placeItems: 'center',
            background: active ? '#dbeafe' : '#f1f5f9',
            color: active ? HCM_BLUE : HCM_GRAY,
            border: `1px solid ${active ? '#bfdbfe' : '#e2e8f0'}`,
            fontSize: 11,
            fontWeight: 900,
          }}
        >
          {icon}
        </div>
        {!last ? <div style={{ width: 2, minHeight: 34, background: '#dbeafe' }} /> : null}
      </div>
      <div style={{ ...cardStyle, padding: 12, marginBottom: last ? 0 : 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <strong style={{ color: '#0f172a', fontSize: 14 }}>{title}</strong>
          <span style={{ color: active ? HCM_GREEN : HCM_GRAY, fontSize: 11, fontWeight: 900 }}>
            {active ? status : 'PENDING'}
          </span>
        </div>
        <div style={{ color: '#475569', fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>
          {summary}
        </div>
      </div>
    </div>
  );
}

export default function HCMPanel() {
  const [episodes, setEpisodes] = useState([]);
  const [openEpisodes, setOpenEpisodes] = useState([]);
  const [effectiveness, setEffectiveness] = useState([]);
  const [knowledgeItems, setKnowledgeItems] = useState([]);
  const [curationDrafts, setCurationDrafts] = useState({});
  const [curationSaving, setCurationSaving] = useState({});
  const [latestDetail, setLatestDetail] = useState(null);
  const [rawContextVisible, setRawContextVisible] = useState(false);
  const [technicalVisible, setTechnicalVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailsError, setDetailsError] = useState('');

  const latestEpisode = episodes[0] || null;
  const latestEvents = asArray(latestDetail?.events);
  const latestDecisions = asArray(latestDetail?.decisions);
  const latestEffectiveness = asArray(latestDetail?.effectiveness).at(-1) || null;
  const latestDecision = latestDecisions.at(-1) || null;
  const learningEvent = firstEvent(latestEvents, 'learning');
  const reasoningEvent = firstEvent(latestEvents, 'reasoning');
  const recommendationEvent = latestEvent(latestEvents, 'recommendation');
  const predictionEvent = latestEvent(latestEvents, 'prediction');
  const feedbackEvent = latestEvent(latestEvents, 'feedback');
  const actionEvent = latestEvent(latestEvents, 'action');
  const experienceEvent = latestEvent(latestEvents, 'experience_learned');
  const initialContext = latestDetail?.chain?.initialContext || latestEpisode?.contextSnapshot || {};
  const targetContext = initialContext?.analytics ? initialContext : initialContext?.global || initialContext;
  const systemAnalytics = targetContext?.systemAnalytics || initialContext?.systemAnalytics || {};
  const systemReasoning =
    targetContext?.systemReasoning ||
    targetContext?.reasoning ||
    systemAnalytics?.systemReasoning ||
    {};
  const beforeMetrics =
    getLocalMetrics(latestEffectiveness?.beforeMetrics) ||
    getLocalMetrics(targetContext) ||
    getLocalMetrics(initialContext?.global) ||
    getLocalMetrics(latestEpisode);
  const feedbackContent = feedbackEvent?.content || {};
  const afterMetrics =
    getLocalMetrics(latestEffectiveness?.afterMetrics) ||
    getLocalMetrics(feedbackContent) ||
    getLocalMetrics(feedbackContent.feedback) ||
    getLocalMetrics({ globalOEE: latestEffectiveness?.afterGlobalOEE });
  const availabilityGain = metricGain(beforeMetrics, afterMetrics, 'availability');
  const performanceGain = metricGain(beforeMetrics, afterMetrics, 'performance');
  const qualityGain = metricGain(beforeMetrics, afterMetrics, 'quality');
  const globalGain =
    toNumberOrNull(latestEffectiveness?.oeeGain ?? latestEffectiveness?.globalOEEGain) ??
    metricGain(beforeMetrics, afterMetrics, 'oee');
  const healthChange = toNumberOrNull(latestEffectiveness?.healthChange);
  const decisionScore = scoreDecision(latestEffectiveness);
  const dominantLoss = text(
    getNested(targetContext, [
      'systemAnalytics.dominantLosses.0.dominantDimension',
      'systemAnalytics.dominantLosses.0.dominantLoss',
      'systemAnalytics.dominantLoss',
      'systemReasoning.dominantLoss',
      'reasoning.dominantLoss',
    ])
  );
  const criticalCps = text(
    latestEpisode?.targetCps ||
      latestDecision?.targetCps ||
      initialContext?.global?.bottleneck ||
      initialContext?.bottleneck ||
      getNested(targetContext, [
        'systemAnalytics.criticalCPS.cpsId',
        'systemAnalytics.criticalCps',
        'criticalCPS.cpsId',
      ])
  );
  const criticalAssetName = text(
    getNested(targetContext, [
      'systemAnalytics.criticalCPS.cpsName',
      'criticalCPS.cpsName',
      'systemAnalytics.criticalityRanking.0.cpsName',
    ])
  );
  const risk = text(
    initialContext?.global?.risk ||
      initialContext?.risk ||
      systemAnalytics?.riskLevel ||
      systemReasoning?.riskLevel
  );
  const probableCause = text(systemReasoning?.probableCause || systemReasoning?.primaryIssue);
  const systemState = text(systemReasoning?.systemState || systemAnalytics?.systemState?.state);
  const recommendation =
    recommendationEvent?.content?.recommendation ||
    latestDecision?.recommendation ||
    latestEpisode?.recommendation ||
    systemReasoning?.recommendation ||
    'No recommendation recorded.';
  const lessonLearned = text(
    experienceEvent?.content?.experienceLearned || latestEffectiveness?.experienceLearned,
    summarizeExperience({
    result: latestEffectiveness?.result,
    globalGain,
    availabilityGain,
    dominantLoss,
    })
  );

  const closedCount = useMemo(
    () => episodes.filter((episode) => episode.status === 'closed').length,
    [episodes]
  );

  const similarEpisodes = useMemo(() => {
    if (!latestEpisode) return [];
    return episodes
      .filter((episode) => episode.episodeId !== latestEpisode.episodeId)
      .filter(
        (episode) =>
          episode.trigger === latestEpisode.trigger ||
          episode.targetCps === latestEpisode.targetCps ||
          compactJson(episode.contextSnapshot).toLowerCase().includes(dominantLoss.toLowerCase())
      )
      .slice(0, 3)
      .map((episode) => {
        const episodeEffectiveness = effectiveness.find((item) => item.episodeId === episode.episodeId);
        return {
          episode,
          effectiveness: episodeEffectiveness,
          recommendation:
            episode.recommendation ||
            episode.contextSnapshot?.recommendation ||
            '-',
        };
      });
  }, [dominantLoss, effectiveness, episodes, latestEpisode]);

  const setDraftComment = useCallback((knowledgeId, comment) => {
    setCurationDrafts((prev) => ({
      ...prev,
      [knowledgeId]: {
        ...(prev[knowledgeId] || {}),
        comment,
      },
    }));
  }, []);

  const saveCuration = useCallback(async (knowledgeId, status) => {
    const comment = text(curationDrafts[knowledgeId]?.comment, '');
    setCurationSaving((prev) => ({ ...prev, [knowledgeId]: true }));
    setError('');
    try {
      const response = await fetch(`${getHcmApiBase()}/knowledge/${knowledgeId}/curation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          comment,
          curatedBy: 'human-operator',
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error || 'Failed to save knowledge curation.');
      const updated = json?.knowledgeItem;
      setKnowledgeItems((prev) =>
        prev.map((item) => (item.knowledgeId === knowledgeId ? updated || item : item))
      );
      setCurationDrafts((prev) => ({
        ...prev,
        [knowledgeId]: {
          ...(prev[knowledgeId] || {}),
          comment: '',
        },
      }));
    } catch (error) {
      setError(error?.message || 'Failed to save knowledge curation.');
    } finally {
      setCurationSaving((prev) => ({ ...prev, [knowledgeId]: false }));
    }
  }, [curationDrafts]);

  const loadLatestDetail = useCallback(async (episodeId, signal) => {
    if (!episodeId) {
      setLatestDetail(null);
      return null;
    }

    setDetailsLoading(true);
    setDetailsError('');
    const timeoutController = new AbortController();
    let timedOut = false;
    const abortFromParent = () => timeoutController.abort();
    if (signal?.aborted) abortFromParent();
    signal?.addEventListener('abort', abortFromParent, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, 10000);
    try {
      const detailResponse = await fetch(`${getHcmApiBase()}/episode/${episodeId}`, {
        cache: 'no-store',
        signal: timeoutController.signal,
      });
      const detailJson = await detailResponse.json().catch(() => null);
      if (!detailResponse.ok) {
        throw new Error(detailJson?.error || 'Failed to load HCM episode detail.');
      }

      setLatestDetail(detailJson?.episode || null);
      return detailJson?.episode || null;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = timedOut
        ? 'HCM episode detail timed out after 10 seconds.'
        : error?.message || 'Failed to load HCM episode detail.';
      setDetailsError(message);
      throw new Error(message);
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromParent);
      setDetailsLoading(false);
    }
  }, []);

  const loadEpisodes = useCallback(
    async (signal) => {
      setError('');
      setLoading(true);
      const fetchCollection = async (path, label) => {
        const timeoutController = new AbortController();
        let timedOut = false;
        const abortFromParent = () => timeoutController.abort();
        if (signal?.aborted) abortFromParent();
        signal?.addEventListener('abort', abortFromParent, { once: true });
        const timeoutId = setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, 10000);

        try {
          const response = await fetch(`${getHcmApiBase()}${path}`, {
            cache: 'no-store',
            signal: timeoutController.signal,
          });
          const json = await response.json().catch(() => null);
          if (!response.ok) throw new Error(json?.error || `${label} request failed.`);
          return json;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (timedOut) throw new Error(`${label} timed out after 10 seconds.`);
          throw new Error(`${label}: ${error?.message || 'request failed.'}`);
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', abortFromParent);
        }
      };

      let latestEpisodeId = null;
      try {
        const results = await Promise.allSettled([
          fetchCollection('/episodes?limit=20', 'Episodes'),
          fetchCollection('/episodes/open', 'Open episodes'),
          fetchCollection('/effectiveness?limit=20', 'Effectiveness'),
          fetchCollection('/knowledge?limit=20', 'Knowledge'),
        ]);
        const errors = [];
        const [episodesResult, openResult, effectivenessResult, knowledgeResult] = results;

        if (episodesResult.status === 'fulfilled') {
          const loadedEpisodes = asArray(episodesResult.value?.episodes);
          setEpisodes(loadedEpisodes);
          latestEpisodeId = loadedEpisodes[0]?.episodeId || null;
        } else if (!signal?.aborted) {
          errors.push(episodesResult.reason?.message || 'Failed to load HCM episodes.');
        }

        if (openResult.status === 'fulfilled') {
          setOpenEpisodes(asArray(openResult.value?.episodes));
        } else if (!signal?.aborted) {
          errors.push(openResult.reason?.message || 'Failed to load open HCM episodes.');
        }

        if (effectivenessResult.status === 'fulfilled') {
          setEffectiveness(asArray(effectivenessResult.value?.effectiveness));
        } else if (!signal?.aborted) {
          errors.push(effectivenessResult.reason?.message || 'Failed to load HCM effectiveness.');
        }

        if (knowledgeResult.status === 'fulfilled') {
          setKnowledgeItems(asArray(knowledgeResult.value?.knowledgeItems));
        } else if (!signal?.aborted) {
          errors.push(knowledgeResult.reason?.message || 'Failed to load HCM knowledge.');
        }

        if (errors.length) setError(errors.join(' '));
      } finally {
        setLoading(false);
      }

      if (latestEpisodeId && !signal?.aborted) {
        loadLatestDetail(latestEpisodeId, signal).catch((error) => {
          if (error?.name !== 'AbortError') console.warn('[HCM_DETAIL_WARN]', error?.message || error);
        });
      }
    },
    [loadLatestDetail]
  );

  useEffect(() => {
    const controller = new AbortController();
    loadEpisodes(controller.signal).catch((err) => {
      if (err?.name === 'AbortError') return;
      setError(err?.message || 'Failed to load HCM data.');
      setLoading(false);
      setDetailsLoading(false);
    });

    return () => controller.abort();
  }, [loadEpisodes]);

  return (
    <section
      style={{
        borderRadius: 16,
        padding: 18,
        background: '#f8fafc',
        border: '1px solid #dbeafe',
        display: 'grid',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: '#0f172a' }}>
            Hierarchical Cognitive Memory (HCM)
          </h2>
          <div style={{ marginTop: 4, color: '#64748b', fontSize: 13 }}>
            Local cognitive episode memory for ACSM learning, reasoning, decisions, feedback, and effectiveness.
          </div>
        </div>
        <TinyButton onClick={() => loadEpisodes().catch((err) => setError(err?.message || 'Failed to refresh HCM data.'))}>
          Refresh
        </TinyButton>
      </div>

      {error ? (
        <div style={{ ...cardStyle, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b' }}>
          {error}
        </div>
      ) : null}

      {loading ? <div style={{ color: '#64748b', fontWeight: 800 }}>Loading HCM episodes...</div> : null}

      {!loading ? (
        <div style={cardStyle}>
          <SectionHeader title="Original CPS Knowledge - read only" />
          <div style={{ marginTop: 8, color: '#64748b', fontSize: 13 }}>
            Human curation is stored separately and never edits the original CPS knowledge.
          </div>
          <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
            {knowledgeItems.length ? (
              knowledgeItems.slice(0, 20).map((item) => {
                const curation = item.humanCuration || {};
                const status = curation.status || 'Not reviewed';
                const saving = Boolean(curationSaving[item.knowledgeId]);
                return (
                  <div key={item.knowledgeId} style={{ ...cardStyle, padding: 12, background: '#f8fafc' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                      <FieldCard label="Knowledge ID" value={item.knowledgeId} wide />
                      <FieldCard label="CPS" value={item.cpsId} />
                      <FieldCard label="Source" value={item.source} />
                      <FieldCard label="Created at" value={formatDate(item.createdAt)} />
                      <FieldCard label="Episode ID" value={item.episodeId || '-'} />
                      <FieldCard label="Review" value={status} />
                      <FieldCard label="Knowledge / Pattern / Reasoning" value={knowledgeText(item)} wide />
                      <FieldCard label="Evidence" value={prettyJson(knowledgeEvidence(item))} wide />
                      <FieldCard label="Recommendation" value={knowledgeRecommendation(item)} wide />
                    </div>
                    {curation.comment ? (
                      <div style={{ marginTop: 10, color: '#334155', fontSize: 13 }}>
                        <strong>Last curation:</strong> {curation.status} by {text(curation.curatedBy)} at {formatDate(curation.curatedAt)}
                        {curation.comment ? ` | ${curation.comment}` : ''}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      <textarea
                        value={curationDrafts[item.knowledgeId]?.comment || ''}
                        onChange={(event) => setDraftComment(item.knowledgeId, event.target.value)}
                        placeholder="Comment for reject or annotation"
                        rows={2}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          border: '1px solid #cbd5e1',
                          borderRadius: 10,
                          padding: 10,
                          fontSize: 13,
                          resize: 'vertical',
                        }}
                      />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <TinyButton onClick={() => saveCuration(item.knowledgeId, 'CONFIRMED')}>
                          {saving ? 'Saving...' : 'Confirm'}
                        </TinyButton>
                        <TinyButton onClick={() => saveCuration(item.knowledgeId, 'REJECTED')}>
                          Reject
                        </TinyButton>
                        <TinyButton onClick={() => saveCuration(item.knowledgeId, 'ANNOTATED')}>
                          Annotate
                        </TinyButton>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ color: '#64748b', fontSize: 13 }}>No CPS knowledge items recorded yet.</div>
            )}
          </div>
        </div>
      ) : null}

      {!loading && !episodes.length ? (
        <div style={{ ...cardStyle, borderStyle: 'dashed', color: '#64748b' }}>
          No cognitive episodes recorded yet.
        </div>
      ) : null}

      {episodes.length ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <FieldCard label="Loaded Episodes" value={episodes.length} />
            <FieldCard label="Open Episodes" value={openEpisodes.length} />
            <FieldCard label="Closed in Loaded Window" value={closedCount} />
            <FieldCard label="Recent Effectiveness" value={effectiveness.length} />
          </div>

          <div style={cardStyle}>
            <SectionHeader title="Episode Summary" />
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <FieldCard label="Episode ID" value={latestEpisode?.episodeId || '-'} wide />
              <FieldCard
                label="Status"
                value={
                  <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Badge tone={statusTone(latestEpisode?.status)}>{text(latestEpisode?.status).toUpperCase()}</Badge>
                    <Badge tone={resultTone(latestEffectiveness?.result)}>
                      {normalizeResult(latestEffectiveness?.result)}
                    </Badge>
                  </span>
                }
              />
              <FieldCard label="Start" value={formatDate(latestEpisode?.startedAt)} />
              <FieldCard label="End" value={formatDate(latestEpisode?.closedAt)} />
              <FieldCard label="Duration" value={formatDuration(latestEpisode?.startedAt, latestEpisode?.closedAt)} />
            </div>
          </div>

          <div style={cardStyle}>
            <SectionHeader
              title="Context"
              action={<TinyButton onClick={() => setRawContextVisible((value) => !value)}>Show Raw Context</TinyButton>}
            />
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
              <FieldCard label="CPS" value={criticalCps} />
              <FieldCard label="Asset" value={criticalAssetName} />
              <FieldCard label="OEE" value={formatPct(latestEpisode?.oee ?? latestEpisode?.globalOEE)} />
              <FieldCard label="Availability" value={formatPct(beforeMetrics?.availability)} />
              <FieldCard label="Performance" value={formatPct(beforeMetrics?.performance)} />
              <FieldCard label="Quality" value={formatPct(beforeMetrics?.quality)} />
              <FieldCard label="Health" value={text(initialContext?.health || targetContext?.health)} />
              <FieldCard label="Target OEE" value={formatPct(latestEpisode?.targetOEE)} />
              <FieldCard label="Risk" value={risk} />
              <FieldCard label="Dominant Loss" value={dominantLoss} />
              <FieldCard label="Probable Cause" value={probableCause} />
              <FieldCard label="System State" value={systemState} />
            </div>
            {rawContextVisible ? <RawBlock title="Raw Context" value={initialContext} /> : null}
          </div>

          <div style={cardStyle}>
            <SectionHeader
              title="Decision Timeline"
              action={
                <TinyButton onClick={() => setTechnicalVisible((value) => !value)}>
                  Show technical details
                </TinyButton>
              }
            />
            <div style={{ marginTop: 14 }}>
              <TimelineStep
                icon="L"
                title="Learning"
                status={learningEvent ? 'RECORDED' : 'missing'}
                summary={`Pattern detected: ${text(
                  learningEvent?.content?.learningPattern ||
                    getNested(targetContext, ['systemAnalytics.learningPattern', 'learningPattern']),
                  'not recorded'
                )}`}
              />
              <TimelineStep
                icon="R"
                title="Reasoning"
                status={reasoningEvent || systemReasoning ? 'RECORDED' : 'missing'}
                summary={`Cause: ${probableCause}`}
              />
              <TimelineStep
                icon="P"
                title="Prediction"
                status={predictionEvent || getNested(targetContext, ['systemAnalytics.systemForecast', 'systemForecast']) ? 'RECORDED' : 'missing'}
                summary={text(predictionEvent?.content?.summary || compactJson(systemAnalytics?.systemForecast), 'No prediction recorded.')}
              />
              <TimelineStep
                icon="A"
                title="Recommendation"
                status={recommendationEvent || latestDecision ? 'RECORDED' : 'missing'}
                summary={text(recommendation)}
              />
              <TimelineStep
                icon="D"
                title="Decision / Action"
                status={latestDecision ? 'RECORDED' : 'missing'}
                summary={latestDecision ? `ACSM selected ${text(latestDecision.action || latestDecision.strategy)} for ${text(latestDecision.targetCps || criticalCps)}.` : 'No decision recorded.'}
              />
              <TimelineStep
                icon="F"
                title="Feedback"
                status={feedbackEvent ? 'RECORDED' : 'missing'}
                summary={feedbackEvent?.content?.message || feedbackEvent?.content?.observedEffect || actionEvent?.content?.executionStatus || 'No operational feedback recorded yet.'}
              />
              <TimelineStep
                icon="E"
                title="Effectiveness"
                status={latestEffectiveness ? 'RECORDED' : 'missing'}
                summary={latestEffectiveness ? `${normalizeResult(latestEffectiveness.result)}: ${formatPct(globalGain)} global gain.` : 'No effectiveness calculated yet.'}
              />
              <TimelineStep
                icon="X"
                title="Experience Learned"
                status={latestEffectiveness ? 'RECORDED' : 'missing'}
                summary={lessonLearned}
                last
              />
            </div>
          </div>

          <div style={cardStyle}>
            <SectionHeader title="Decision Evaluation" />
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
              <MetricBar label="Availability Gain" value={availabilityGain} />
              <MetricBar label="Performance Gain" value={performanceGain} />
              <MetricBar label="Quality Gain" value={qualityGain} />
                <MetricBar label="OEE Gain" value={globalGain} />
                <MetricBar label="Health Change" value={healthChange} />
                <MetricBar label="Decision Score" value={decisionScore} score />
            </div>
          </div>

          <div style={cardStyle}>
            <SectionHeader title="Lesson Learned" />
            <div
              style={{
                marginTop: 12,
                borderLeft: `4px solid ${gainTone(globalGain)}`,
                background: '#f8fafc',
                padding: 14,
                borderRadius: 10,
                color: '#0f172a',
                fontSize: 15,
                fontWeight: 800,
                lineHeight: 1.55,
              }}
            >
              &quot;{lessonLearned}&quot;
            </div>
          </div>

          <div style={cardStyle}>
            <SectionHeader title="Similar Episodes" />
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              {similarEpisodes.length ? (
                similarEpisodes.map(({ episode, effectiveness: item, recommendation: similarRecommendation }) => (
                  <div key={episode.episodeId} style={{ ...cardStyle, padding: 12, background: '#f8fafc' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <strong style={{ color: '#0f172a', fontSize: 13 }}>{episode.episodeId}</strong>
                      <span style={{ display: 'flex', gap: 6 }}>
                        <Badge tone={statusTone(episode.status)}>{text(episode.status).toUpperCase()}</Badge>
                        <Badge tone={resultTone(item?.result)}>{normalizeResult(item?.result)}</Badge>
                      </span>
                    </div>
                    <div style={{ marginTop: 8, color: '#475569', fontSize: 13 }}>
                      Global Gain: <strong>{formatPct(item?.globalOEEGain)}</strong> | Decision Score:{' '}
                      <strong>{scoreDecision(item) ?? '-'}</strong>
                    </div>
                    <div style={{ marginTop: 6, color: '#334155', fontSize: 13 }}>
                      {text(similarRecommendation)}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ color: '#64748b', fontSize: 13 }}>No similar episodes found yet.</div>
              )}
            </div>
          </div>

          {technicalVisible ? (
            <div style={cardStyle}>
              <SectionHeader title="Technical Details" />
              <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                <RawBlock title="Raw Context" value={initialContext} />
                <RawBlock title="Raw Reasoning" value={reasoningEvent?.content || systemReasoning} />
                <RawBlock title="Raw Prediction" value={predictionEvent?.content || systemAnalytics?.systemForecast} />
                <RawBlock title="Raw Recommendation" value={recommendationEvent?.content || recommendation} />
                <RawBlock title="Raw Decision" value={latestDecision} />
                <RawBlock title="Raw Feedback" value={feedbackEvent?.content} />
                <RawBlock title="Raw Effectiveness" value={latestEffectiveness} />
                <RawBlock title="Raw Events" value={latestEvents} />
              </div>
            </div>
          ) : null}

          {detailsLoading ? <div style={{ color: '#64748b', fontWeight: 800 }}>Loading technical details...</div> : null}
          {detailsError ? (
            <div style={{ ...cardStyle, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b' }}>
              {detailsError}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
