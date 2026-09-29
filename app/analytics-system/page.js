'use client';

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { useCPSContext } from '../../context/CPSContext';
import GenerativeAIInterpretationPanel from '../../components/GenerativeAIInterpretationPanel';
import { getActiveAcsmConfig, normalizeCpsId } from '../../lib/acsm/config';
import { buildLevel2KnowledgePackage } from '../../lib/ai/knowledgePackages';
import { sanitizeTextEncoding } from '../../lib/text/sanitizeTextEncoding';
import styles from './ACSMSystemDashboard.module.css';

const DASH = '\u2014';
const activeAcsm = getActiveAcsmConfig();

const hasValue = (value) => value !== undefined && value !== null && value !== '';
const hasObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : hasValue(value) ? [value] : []);

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const pct = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? DASH : `${(numeric * 100).toFixed(1)}%`;
};

const extractOeeValue = (...sources) => {
  for (const source of sources) {
    const candidates = [
      source?.oee?.current,
      source?.oee?.oee,
      source?.oee?.value,
      source?.oee,
      source?.current,
      source?.value,
      source,
    ];
    const value = candidates.find(
      (candidate) => candidate !== null && candidate !== undefined && candidate !== ''
    );
    const numeric = toNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
};

const extractHealthLabel = (...sources) => {
  const candidates = sources.flatMap((source) => [
    source?.globalState?.healthLabel,
    source?.healthLabel,
    source?.health?.healthLabel,
    source?.health?.label,
    source?.health?.status,
    source?.status?.healthLabel,
  ]);
  return candidates.find(hasValue) ?? null;
};

const extractDominantLoss = (...sources) => {
  const candidates = sources.flatMap((source) => [
    source?.dominantLoss,
    source?.dominantLossNow,
    source?.dominantDimension,
    source?.loss,
    source?.reasoning?.dominantLoss,
    source?.reasoning?.dominantLossNow,
    source?.learning?.dominantLoss,
    source?.learning?.dominantLossNow,
    source?.learning?.reasoning?.dominantLoss,
    source?.analytics?.dominantLoss,
    source?.analytics?.reasoning?.dominantLoss,
    source?.ai?.reasoning?.dominantLoss,
  ]);
  return candidates.find(hasValue) ?? null;
};

const num = (value, digits = 2) => {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(digits);
};

const text = (value, fallback = DASH) => {
  if (!hasValue(value)) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return sanitizeTextEncoding(String(value), { fallback });
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => text(item, '')).filter(Boolean);
    return items.length ? items.slice(0, 3).join(' | ') : fallback;
  }
  if (typeof value === 'object') {
    const preferred = [
      'executiveInterpretation',
      'explanation',
      'executiveSummary',
      'summary',
      'recommendation',
      'rationale',
      'action',
      'coordinationAction',
      'dominantLoss',
      'cpsId',
      'name',
      'state',
      'status',
      'message',
    ];
    const direct = preferred.map((key) => value?.[key]).find(hasValue);
    if (hasValue(direct)) return text(direct, fallback);
    const primitives = Object.entries(value)
      .filter(([, entryValue]) => hasValue(entryValue) && typeof entryValue !== 'object')
      .slice(0, 3)
      .map(([key, entryValue]) => `${key}: ${entryValue}`);
    return primitives.length ? primitives.join(' | ') : fallback;
  }
  return fallback;
};

const dateText = (value) => {
  if (!hasValue(value)) return DASH;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? DASH : date.toLocaleString('pt-BR');
};

const formatCpsId = (value) => {
  const normalized = normalizeCpsId(value);
  const match = normalized.match(/^cps(\d+)$/);
  return match ? `CPS-${match[1].padStart(3, '0')}` : text(value);
};

const lastNumericFromSeries = (value) => {
  if (!Array.isArray(value)) return toNumber(value);
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    const numeric =
      toNumber(item?.predictedSystemOEE) ??
      toNumber(item?.predictedGlobalOEE) ??
      toNumber(item?.expectedOEE) ??
      toNumber(item?.forecastOEE) ??
      toNumber(item?.oee) ??
      toNumber(item?.value) ??
      toNumber(item);
    if (numeric !== null) return numeric;
  }
  return null;
};

const firstNumeric = (...values) => {
  for (const value of values) {
    const numeric = lastNumericFromSeries(value);
    if (numeric !== null) return numeric;
  }
  return null;
};

const firstPresent = (...values) => values.find(hasValue);

const firstPrimitive = (...values) =>
  values.find((value) => hasValue(value) && ['string', 'number', 'boolean'].includes(typeof value));

const getSystemHealth = (analytics = {}) => {
  const health = analytics?.health;
  return firstPrimitive(
    analytics?.systemHealth,
    analytics?.globalHealth,
    analytics?.healthState,
    health?.label,
    health
  );
};

const getCriticalCpsId = (analytics = {}) => {
  const ranking = asArray(
    analytics?.criticalityRanking ||
      analytics?.cpsContributionRanking ||
      analytics?.criticality ||
      analytics?.coordinatorOutput?.criticalityRanking
  );
  const rankedCritical = ranking
    .map((item) => normalizeCpsId(item?.cpsId || item?.id || item?.baseTopic || item?.cps || item))
    .find(Boolean);
  const bottleneck = analytics?.bottleneck || analytics?.bottleneckCps;
  return (
    rankedCritical ||
    normalizeCpsId(analytics?.criticalCPS?.cpsId || analytics?.criticalCPS || analytics?.criticalCps?.cpsId || analytics?.criticalCps) ||
    normalizeCpsId(bottleneck?.cpsId || bottleneck)
  );
};

const getExecutiveRecommendation = ({ analytics = {}, reasoning = {}, actionPlan = {} } = {}) =>
  firstPresent(
    analytics?.executiveRecommendation,
    analytics?.recommendationSummary,
    reasoning?.executiveRecommendation,
    reasoning?.recommendationSummary,
    actionPlan?.executiveRecommendation,
    actionPlan?.recommendationSummary,
    actionPlan?.summary,
    analytics?.summary,
    analytics?.recommendation,
    reasoning?.recommendation,
    actionPlan?.recommendation,
    analytics?.coordinationAction
  );

const getPredictedSystemOEE = (analytics = {}, forecast = {}) =>
  firstNumeric(
    analytics?.predictedSystemOEE,
    analytics?.predictedGlobalOEE,
    forecast?.predictedSystemOEE,
    forecast?.predictedGlobalOEE,
    forecast?.predictedOEE,
    forecast?.forecastOEE
  );

const isPlayPhase = (cps) =>
  String(
    cps?.lifecyclePhase ??
      cps?.lifecycle?.phase ??
      cps?.lifecycle?.currentPhase ??
      cps?.currentPhase ??
      ''
  )
    .trim()
    .toLowerCase() === 'play';

const uniqueByCpsId = (items) => {
  const map = new Map();
  items.filter(Boolean).forEach((item) => {
    const key = normalizeCpsId(item?.id || item?.cpsId || item?.topic || item?.baseTopic);
    if (key && !map.has(key)) map.set(key, item);
  });
  return [...map.values()];
};

function Field({ label, value }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <strong className={styles.value}>{hasValue(value) ? value : DASH}</strong>
    </div>
  );
}

function Kpi({ label, value, compact = false }) {
  return (
    <div className={styles.kpi}>
      <span className={styles.label}>{label}</span>
      <strong className={`${styles.value} ${compact ? styles.compactValue : ''}`.trim()}>
        {hasValue(value) ? value : DASH}
      </strong>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ReadableText({ value }) {
  return <div className={styles.textBlock}>{text(value)}</div>;
}

function getCpsAnalytics(cps, analyticsByCps) {
  const ids = [cps?.id, cps?.cpsId, cps?.topic, cps?.baseTopic].map(normalizeCpsId).filter(Boolean);
  const key = Object.keys(analyticsByCps || {}).find((candidate) =>
    ids.includes(normalizeCpsId(candidate))
  );
  return key ? analyticsByCps[key] : {};
}

function buildContributionRows({ activeCps, analytics, cpsAnalytics }) {
  const ranking = asArray(
    analytics?.criticalityRanking ||
      analytics?.cpsContributionRanking ||
      analytics?.criticality ||
      analytics?.coordinatorOutput?.criticalityRanking
  );

  return activeCps.map((cps) => {
    const cpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.topic || cps?.baseTopic);
    const rankingIndex = ranking.findIndex((candidate) =>
      [candidate?.cpsId, candidate?.id, candidate?.baseTopic, candidate?.cps]
        .map(normalizeCpsId)
        .includes(cpsId)
    );
    const item = rankingIndex >= 0 ? ranking[rankingIndex] : {};
    const localAnalytics = getCpsAnalytics(cps, cpsAnalytics);
    const oee = extractOeeValue(localAnalytics, cps, item);
    const row = {
      cps: formatCpsId(cpsId),
      oee: pct(oee),
      health: text(extractHealthLabel(cps, item, localAnalytics)),
      rank: rankingIndex >= 0 ? item?.rank ?? rankingIndex + 1 : DASH,
      dominantLoss: text(extractDominantLoss(item, localAnalytics, cps)),
    };

    return row;
  });
}

function ContributionTable({ rows }) {
  if (!rows.length) return <div className={styles.empty}>No CPS in Play for current ACSM view.</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>CPS</th>
            <th>OEE</th>
            <th>Health</th>
            <th>Criticality / Rank</th>
            <th>Dominant Loss</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.cps}>
              <td>{row.cps}</td>
              <td>{row.oee}</td>
              <td>{row.health}</td>
              <td>{row.rank}</td>
              <td>{row.dominantLoss}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SystemCognitiveMemory({ acsmId }) {
  const [state, setState] = useState({ loading: true, episodes: [], error: '' });

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/hcm/episodes', { cache: 'no-store', signal: controller.signal });
        const json = await response.json().catch(() => null);
        if (!response.ok) throw new Error(json?.error || 'Failed to load HCM episodes.');
        const normalizedAcsm = String(acsmId || '').toLowerCase();
        const episodes = asArray(json?.episodes)
          .filter((episode) => {
            const haystack = JSON.stringify(episode || {}).toLowerCase();
            return (
              String(episode?.source || '').toLowerCase() === normalizedAcsm ||
              String(episode?.target || '').toLowerCase().includes('acsm') ||
              haystack.includes(normalizedAcsm) ||
              haystack.includes('systemanalytics')
            );
          })
          .sort((a, b) => {
            const aTime = new Date(a?.closedAt || a?.updatedAt || a?.openedAt || a?.createdAt || 0).getTime();
            const bTime = new Date(b?.closedAt || b?.updatedAt || b?.openedAt || b?.createdAt || 0).getTime();
            return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
          });
        setState({ loading: false, episodes, error: '' });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        setState({ loading: false, episodes: [], error: error?.message || 'Failed to load HCM episodes.' });
      }
    };
    load();
    return () => controller.abort();
  }, [acsmId]);

  if (state.loading) return <div className={styles.empty}>Loading system cognitive memory...</div>;
  if (state.error) return <div className={styles.empty}>{state.error}</div>;
  if (!state.episodes.length) return <div className={styles.empty}>No system HCM episodes recorded yet.</div>;

  const [featuredEpisode, ...previousEpisodes] = state.episodes;

  const renderEpisode = (episode, featured = false) => {
    const context = episode?.contextSnapshot || {};
    const steps = [
      ['Learning', context?.learning || context?.systemAnalytics?.learningPattern || episode?.trigger],
      ['Reasoning', context?.reasoning || context?.systemReasoning || episode?.dominantLoss],
      ['Recommendation', episode?.recommendation || context?.recommendation],
      ['Decision', episode?.decision || episode?.action || episode?.strategy],
      ['Feedback', episode?.feedback],
      ['Effectiveness', episode?.effectiveness || episode?.result || episode?.closedAt],
    ];

    return (
      <div key={episode?.episodeId || JSON.stringify(episode)} className={featured ? styles.featuredEpisode : styles.field}>
        <div className={styles.episodeMeta}>
          <Field label="Episode ID" value={episode?.episodeId} />
          <Field label="Status" value={episode?.status} />
          <Field label="Opened At" value={dateText(episode?.openedAt || episode?.createdAt)} />
          <Field label="Closed At" value={dateText(episode?.closedAt)} />
          <Field label="Effectiveness" value={text(episode?.effectiveness)} />
          <Field label="Global Gain" value={pct(episode?.globalOEEGain || episode?.globalGain)} />
        </div>
        <div className={styles.trace}>
          {steps.map(([label, value], index) => (
            <div
              key={label}
              className={`${styles.traceStep} ${index < steps.length - 1 ? styles.traceStepLinked : ''}`.trim()}
            >
              <span className={styles.label}>{label}</span>
              <strong className={styles.traceValue}>{text(value)}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {renderEpisode(featuredEpisode, true)}
      {previousEpisodes.length ? (
        <details className={styles.previousEpisodes}>
          <summary>Previous Episodes ({previousEpisodes.length})</summary>
          <div className={styles.previousEpisodesList}>
            {previousEpisodes.map((episode) => renderEpisode(episode))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AnalyticsSystemContent() {
  const {
    acsmConfig,
    stableSystemAnalytics,
    systemAnalytics,
    availableCPS = [],
    addedCPS = [],
    playPhaseCPS = [],
    cpsAnalytics = {},
  } = useCPSContext();

  const config = acsmConfig?.id ? acsmConfig : activeAcsm;
  const analytics = useMemo(
    () => (hasObject(stableSystemAnalytics) ? stableSystemAnalytics : systemAnalytics || {}),
    [stableSystemAnalytics, systemAnalytics]
  );
  const level2KnowledgePackage = useMemo(
    () => buildLevel2KnowledgePackage({ analytics }),
    [analytics]
  );
  const activeCps = useMemo(
    () => uniqueByCpsId([...playPhaseCPS, ...addedCPS, ...availableCPS]).filter(isPlayPhase),
    [addedCPS, availableCPS, playPhaseCPS]
  );
  const expectedCpsCount = asArray(config?.managedCpsIds || config?.allowedCpsIds).length || activeCps.length;

  const globalOEE = analytics?.globalOEE || analytics?.oee || {};
  const systemState = analytics?.systemState || {};
  const reasoning = analytics?.systemReasoning || analytics?.reasoning || {};
  const learning = analytics?.systemLearningModel || analytics?.derivedLearning || analytics?.learning || {};
  const forecast = analytics?.systemForecast || analytics?.prediction || analytics?.predictedRisk || {};
  const actionPlan = analytics?.actionPlan || analytics?.coordinationActionPlan || {};
  const bottleneck = analytics?.bottleneck || analytics?.bottleneckCps;
  const criticalCpsId = getCriticalCpsId(analytics);
  const recommendation = firstPresent(
    analytics?.recommendation,
    reasoning?.recommendation,
    actionPlan?.recommendation,
    analytics?.coordinationAction
  );
  const executiveRecommendation = getExecutiveRecommendation({ analytics, reasoning, actionPlan });
  const predictedSystemOEEValue = getPredictedSystemOEE(analytics, forecast);
  const systemHealth = getSystemHealth(analytics);
  const trend = firstPresent(analytics?.trend, learning?.trend, forecast?.trend);
  const confidence = firstPresent(forecast?.confidence, analytics?.confidence, learning?.confidence);
  const risk = firstPresent(analytics?.riskLevel, forecast?.risk, forecast?.level, learning?.riskLevel);
  const interpretation = firstPresent(
    reasoning?.executiveInterpretation,
    analytics?.executiveInterpretation,
    analytics?.explanation,
    analytics?.executiveSummary
  );
  const lastUpdate = firstPresent(
    analytics?.lastUpdate,
    analytics?.timestamp,
    analytics?.ts,
    globalOEE?.lastUpdate,
    globalOEE?.ts
  );
  const activeCpsCount = activeCps.length;
  const predictedSystemOEE = activeCpsCount > 0 ? predictedSystemOEEValue : null;
  const contributionRows = buildContributionRows({ activeCps, analytics, cpsAnalytics });

  return (
    <main className={styles.shell}>
      <div className={styles.dashboard}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>ACSM System Analytics Dashboard</span>
            <h1>Manufacturing System Operational and Cognitive Overview</h1>
            <p>Read-only systemic view built from the current ACSM global analytics and CPS population in Play.</p>
          </div>
          <div className={styles.headerGrid}>
            <Field label="ACSM ID" value={config?.code || config?.id} />
            <Field label="Active CPS Population" value={`${activeCpsCount} / ${expectedCpsCount}`} />
            <Field label="Current System State" value={text(systemState?.state || reasoning?.systemState)} />
            <Field label="Last Update" value={dateText(lastUpdate)} />
          </div>
        </header>

        <section className={styles.kpiGrid}>
          <Kpi label="Global OEE" value={pct(globalOEE?.oee ?? globalOEE?.current ?? analytics?.oeeGlobal)} />
          <Kpi label="Active CPS" value={`${activeCpsCount} / ${expectedCpsCount}`} />
          <Kpi label="System Health" value={text(systemHealth)} />
          <Kpi label="Critical CPS" value={criticalCpsId ? formatCpsId(criticalCpsId) : DASH} />
          <Kpi label="System State" value={text(systemState?.state || reasoning?.systemState || risk)} />
        </section>

        <section className={styles.cognitionGrid}>
          <Kpi label="System Learning" value={text(learning?.state || learning?.learningState || learning?.pattern || analytics?.learningPattern)} />
          <Kpi label="Dominant Loss" value={text(reasoning?.dominantLoss || learning?.dominantLoss || analytics?.dominantLoss)} />
          <Kpi label="Predicted OEE" value={pct(predictedSystemOEE)} />
          <Kpi label="Recommendation" value={text(executiveRecommendation)} compact />
        </section>

        <Card title="System Interpretation">
          <ReadableText value={interpretation || 'No system interpretation available yet.'} />
        </Card>

        <div className={styles.twoColumnGrid}>
          <Card title="System Learning">
            <div className={styles.fieldGrid}>
              <Field label="Learning State" value={text(learning?.state || learning?.learningState)} />
              <Field label="Pattern" value={text(learning?.pattern || analytics?.learningPattern)} />
              <Field label="Trend" value={text(trend)} />
              <Field label="Risk" value={text(risk)} />
              <Field label="Confidence" value={num(confidence)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <span className={styles.label}>Evidence</span>
              <ReadableText value={analytics?.systemEvidence || analytics?.systemEvidenceList || learning?.evidence} />
            </div>
          </Card>

          <Card title="System Reasoning">
            <div className={styles.fieldGrid}>
              <Field label="Dominant Loss" value={text(reasoning?.dominantLoss || analytics?.dominantLoss)} />
              <Field label="Critical CPS" value={criticalCpsId ? formatCpsId(criticalCpsId) : DASH} />
              <Field label="Causality" value={text(analytics?.systemCausality || reasoning?.causality)} />
              <Field label="Bottleneck" value={text(bottleneck?.cpsId || bottleneck)} />
              <Field label="Recommendation" value={text(recommendation)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <span className={styles.label}>Explanation</span>
              <ReadableText value={reasoning?.explanation || analytics?.explanation} />
            </div>
          </Card>
        </div>

        <div className={styles.twoColumnGrid}>
          <Card title="Prediction">
            <div className={styles.fieldGrid}>
              <Field label="Predicted System OEE" value={pct(predictedSystemOEE)} />
              <Field label="Trend" value={text(forecast?.trend || analytics?.trend)} />
              <Field label="Confidence" value={num(confidence)} />
              <Field label="Risk" value={text(risk)} />
            </div>
          </Card>

          <Card title="System Coordination">
            <div className={styles.fieldGrid}>
              <Field label="Coordination Action" value={text(analytics?.coordinationAction || actionPlan?.action || actionPlan?.actionType)} />
              <Field label="Target CPS" value={text(actionPlan?.targetCPS || actionPlan?.targetCps || criticalCpsId)} />
              <Field label="Priority" value={text(actionPlan?.priority || analytics?.priority)} />
              <Field label="Expected Gain" value={pct(actionPlan?.expectedGain)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <span className={styles.label}>Rationale</span>
              <ReadableText value={actionPlan?.rationale || reasoning?.rationale} />
            </div>
          </Card>
        </div>

        <Card title="CPS Contribution and Criticality">
          <ContributionTable rows={contributionRows} />
        </Card>

        <Card title="System Cognitive Memory">
          <SystemCognitiveMemory acsmId={config?.id || activeAcsm.id} />
        </Card>

        <GenerativeAIInterpretationPanel
          level="level2"
          contextType="system"
          knowledgePackage={level2KnowledgePackage}
          language="en"
          outputType="summary"
          title="Generative AI Interpretation - System-Level Intelligence"
        />
      </div>
    </main>
  );
}

export default function AnalyticsSystemPage() {
  return (
    <Suspense fallback={<div className={styles.shell}>Loading system analytics dashboard...</div>}>
      <AnalyticsSystemContent />
    </Suspense>
  );
}
