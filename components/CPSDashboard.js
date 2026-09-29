'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Brain,
  CheckCircle2,
  Gauge,
  HeartPulse,
  Lightbulb,
  Route,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import AdaptiveTimeline from './AdaptiveTimeline';
import HistoryRecordsButton from './HistoryRecordsButton';
import styles from './CPSDashboard.module.css';
import { sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';

const DASH = '\u2014';
const cx = (...classes) => classes.filter(Boolean).join(' ');
const LIFECYCLE_PHASES = new Set(['plug', 'play', 'unplug']);

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const hasValue = (value) => value !== undefined && value !== null && value !== '';
const hasObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

const text = (value, fallback = DASH) => {
  if (!hasValue(value)) return fallback;
  return sanitizeTextEncoding(value, { fallback });
};

const labelize = (value) =>
  String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());

const formatPct = (value) => {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  return `${(numeric * 100).toFixed(1)}%`;
};

const formatDeltaPct = (value) => {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  const percent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
};

const formatNumber = (value, digits = 2) => {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(digits);
};

const formatMs = (value) => {
  const formatted = formatNumber(value, 0);
  return formatted === DASH ? DASH : `${formatted} ms`;
};

const formatDate = (value) => {
  if (!hasValue(value)) return DASH;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString('pt-BR');
};

const compactValue = (value) => {
  if (!hasValue(value)) return DASH;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return text(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const compactTextValue = (value) => {
  if (!hasValue(value)) return DASH;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return compactValue(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(compactTextValue).filter((item) => item && item !== DASH);
    return items.length ? items.slice(0, 2).join(' | ') : DASH;
  }

  if (typeof value === 'object') {
    const preferredKeys = [
      'summary',
      'message',
      'title',
      'label',
      'state',
      'learningState',
      'learningPattern',
      'pattern',
      'dominantLoss',
      'probableCause',
      'recommendation',
      'action',
      'decision',
      'feedback',
      'effectiveness',
      'result',
      'status',
      'strategy',
      'trigger',
    ];
    const direct = preferredKeys.map((key) => value?.[key]).find(hasValue);
    if (hasValue(direct)) return compactTextValue(direct);

    const primitiveEntries = Object.entries(value)
      .filter(([, entryValue]) => hasValue(entryValue) && typeof entryValue !== 'object')
      .slice(0, 2)
      .map(([key, entryValue]) => `${labelize(key)}: ${compactValue(entryValue)}`);
    return primitiveEntries.length ? primitiveEntries.join(' | ') : DASH;
  }

  return DASH;
};

const getOeeValue = (analytics = {}, cps = {}) =>
  toNumber(analytics?.oee?.oee) ??
  toNumber(analytics?.oee?.value) ??
  toNumber(analytics?.oee?.current) ??
  toNumber(cps?.oee?.value) ??
  toNumber(cps?.oee?.current) ??
  toNumber(analytics?.statistics?.oee_mean);

const lastNumericFromSeries = (value) => {
  if (!Array.isArray(value)) return toNumber(value);

  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    const numeric =
      toNumber(item?.predictedOEE) ??
      toNumber(item?.predictedOee) ??
      toNumber(item?.forecastOEE) ??
      toNumber(item?.expectedOEE) ??
      toNumber(item?.oee) ??
      toNumber(item?.value) ??
      toNumber(item);
    if (numeric !== null) return numeric;
  }

  return null;
};

const firstNumericValue = (...values) => {
  for (const value of values) {
    const numeric = lastNumericFromSeries(value);
    if (numeric !== null) return numeric;
  }
  return null;
};

const metricRows = (source, candidates) =>
  candidates
    .map(({ label, paths, formatter = compactValue }) => {
      const value = firstPathValue(source, paths);
      return hasValue(value) ? { label, value: formatter(value) } : null;
    })
    .filter(Boolean);

const firstPathValue = (source, paths) => {
  for (const path of paths) {
    const value = String(path)
      .split('.')
      .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), source);
    if (hasValue(value)) return value;
  }
  return undefined;
};

const isLifecyclePhaseValue = (value) =>
  LIFECYCLE_PHASES.has(String(value || '').trim().toLowerCase());

const firstNonLifecycleValue = (values) =>
  values.find((value) => hasValue(value) && !isLifecyclePhaseValue(value));

const getOperationalStateFromContext = (cps, getCanonicalOperationalState) => {
  const contextualState = firstNonLifecycleValue([
    cps?.operationalState,
    cps?.globalState?.state,
    cps?.globalState?.status,
  ]);
  if (contextualState) return contextualState;

  const canonicalState = getCanonicalOperationalState?.(cps);
  return firstNonLifecycleValue([canonicalState]) || DASH;
};

const operationFieldConfig = {
  cps1: [
    { label: 'Tip Temperature', keys: ['tipTemperature', 'tempPontaSolda', 'currentTemperature'] },
    { label: 'Arc Current', keys: ['arcCurrent', 'correnteArco', 'currentRPM'] },
    { label: 'Gas Pressure', keys: ['gasPressure', 'pressaoGas', 'currentTorque'] },
    { label: 'Piece Counter', keys: ['pieceCounter'] },
    { label: 'Cycle Time', keys: ['cycleTimeMs'], formatter: formatMs },
  ],
  cps5: [
    { label: 'Temperature', keys: ['currentTemperature', 'temperature'] },
    { label: 'RPM', keys: ['currentRPM', 'rpm'] },
    { label: 'Torque', keys: ['currentTorque', 'torque'] },
    { label: 'Piece Counter', keys: ['pieceCounter'] },
    { label: 'Cycle Time', keys: ['cycleTimeMs'], formatter: formatMs },
  ],
  cps7: [
    { label: 'Temperature', keys: ['currentTemperature', 'temperature'] },
    { label: 'RPM', keys: ['currentRPM', 'rpm'] },
    { label: 'Torque', keys: ['currentTorque', 'torque'] },
    { label: 'Piece Counter', keys: ['pieceCounter'] },
    { label: 'Cycle Time', keys: ['cycleTimeMs'], formatter: formatMs },
  ],
};

const getOperationalRows = (cpsId, cps = {}, analytics = {}) => {
  const data = {
    ...(analytics?.telemetry || {}),
    ...(analytics?.features || {}),
    ...(cps?.operationalData || {}),
  };
  const configured = operationFieldConfig[cpsId] || [];
  const usedKeys = new Set();
  const rows = configured
    .map(({ label, keys, formatter = compactValue }) => {
      const key = keys.find((candidate) => hasValue(data?.[candidate]));
      if (!key) return null;
      usedKeys.add(key);
      return { label, value: formatter(data[key]) };
    })
    .filter(Boolean);

  const usedLabels = new Set(rows.map((row) => row.label));
  Object.entries(data).forEach(([key, value]) => {
    if (!hasValue(value) || typeof value === 'object' || usedKeys.has(key)) return;
    const label = labelize(key);
    if (usedLabels.has(label) || key === 'operationMode') return;
    rows.push({ label, value: compactValue(value) });
  });

  return rows;
};

const evidenceFieldConfig = [
  {
    label: 'Cycle Δ',
    paths: [
      'cycleDeltaPct',
      'CycleDeltaPct',
      'cycleDelta',
      'deltas.cycleDeltaPct',
      'quickSignals.cycleDeltaPct',
    ],
  },
  {
    label: 'Temperature Δ',
    paths: [
      'temperatureDeltaPct',
      'TemperatureDeltaPct',
      'tempDeltaPct',
      'deltas.temperatureDeltaPct',
      'quickSignals.temperatureDeltaPct',
    ],
  },
  {
    label: 'RPM Δ',
    paths: [
      'rpmDeltaPct',
      'RPMDeltaPct',
      'deltas.rpmDeltaPct',
      'quickSignals.rpmDeltaPct',
    ],
  },
  {
    label: 'Torque Δ',
    paths: [
      'torqueDeltaPct',
      'TorqueDeltaPct',
      'deltas.torqueDeltaPct',
      'quickSignals.torqueDeltaPct',
    ],
  },
  {
    label: 'OEE Δ',
    paths: [
      'oeeDeltaPct',
      'OEEDeltaPct',
      'oeeDelta',
      'deltas.oeeDeltaPct',
      'quickSignals.oeeDeltaPct',
    ],
  },
];

const getEvidenceRows = (analytics = {}, learning = {}) => {
  const source = {
    ...(hasObject(analytics?.timeSeriesFeatures?.quickSignals)
      ? { quickSignals: analytics.timeSeriesFeatures.quickSignals }
      : {}),
    ...(hasObject(analytics?.evidence) ? analytics.evidence : {}),
    ...(hasObject(learning?.evidence) ? learning.evidence : {}),
    ...(hasObject(learning?.basis) ? learning.basis : {}),
  };

  return evidenceFieldConfig
    .map(({ label, paths }) => {
      const value = firstPathValue(source, paths);
      return hasValue(value) ? { label, value: formatDeltaPct(value) } : null;
    })
    .filter(Boolean);
};

function Section({ icon, title, children, className = '' }) {
  return (
    <section className={cx(styles.section, className)}>
      <div className={styles.sectionTitle}>
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, wide = false }) {
  return (
    <div className={cx(styles.field, wide && styles.fieldWide)}>
      <span className={styles.fieldLabel}>{label}</span>
      <strong className={styles.fieldValue}>{hasValue(value) ? value : DASH}</strong>
    </div>
  );
}

function TextBlock({ label, value }) {
  if (!hasValue(value)) return null;
  return (
    <div className={styles.textBlock}>
      <span className={styles.fieldLabel}>{label}</span>
      <p>{compactTextValue(value)}</p>
    </div>
  );
}

function EvidenceGrid({ rows }) {
  if (!rows.length) return null;
  return (
    <div className={styles.evidenceGrid}>
      {rows.map((row) => (
        <Field key={row.label} label={row.label} value={row.value} />
      ))}
    </div>
  );
}

const formatDisplayCpsId = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  const match = normalized.match(/^cps0*(\d+)$/);
  return match ? `CPS-${match[1].padStart(3, '0')}` : text(value);
};

function CPSHeader({ cps, cpsId, analytics, canonicalOperationalState }) {
  const assetName = cps?.nome || analytics?.cpsName || cpsId;
  const displayCpsId = formatDisplayCpsId(cps?.cpsId || cps?.lifecycle?.cpsId || cpsId);
  const topic = cps?.topic || cps?.baseTopic || analytics?.baseTopic || cpsId;
  const lastUpdate =
    analytics?.lastUpdate ||
    analytics?.oee?.ts ||
    cps?.oee?.lastUpdate ||
    cps?.globalState?.lastUpdate ||
    cps?.health?.lastUpdate;
  const health = cps?.health?.label || cps?.globalState?.healthLabel || analytics?.sourceStatus;

  return (
    <section className={styles.header}>
      <div className={styles.headerMain}>
        <span className={styles.eyebrow}>Individual CPS Dashboard</span>
        <h1>{text(assetName)}</h1>
        <p>{text(displayCpsId)} | {text(topic)}</p>
      </div>
      <div className={styles.headerGrid}>
        <Field label="CPS ID" value={displayCpsId} />
        <Field label="MQTT Topic" value={topic} />
        <Field label="Lifecycle Phase" value={cps?.lifecyclePhase || cps?.lifecycle?.phase || cps?.lifecycle?.currentPhase} />
        <Field label="Operational State" value={canonicalOperationalState} />
        <Field label="Health" value={health || cps?.status || analytics?.sourceStatus} />
        <Field label="Last Update" value={formatDate(lastUpdate)} />
      </div>
    </section>
  );
}

function CPSKpiGrid({ cps, analytics }) {
  const oee = analytics?.oee || cps?.oee || {};
  const kpis = [
    { label: 'OEE', value: getOeeValue(analytics, cps), icon: <TrendingUp size={18} /> },
    { label: 'Availability', value: oee?.availability ?? cps?.oee?.availability, icon: <ShieldCheck size={18} /> },
    { label: 'Performance', value: oee?.performance ?? cps?.oee?.performance, icon: <Gauge size={18} /> },
    { label: 'Quality', value: oee?.quality ?? cps?.oee?.quality, icon: <CheckCircle2 size={18} /> },
  ];

  return (
    <div className={styles.kpis}>
      {kpis.map((kpi) => (
        <div key={kpi.label} className={styles.kpi}>
          <div>
            <span className={styles.kpiLabel}>{kpi.label}</span>
            <strong className={styles.kpiValue}>{formatPct(kpi.value)}</strong>
          </div>
          <i>{kpi.icon}</i>
        </div>
      ))}
    </div>
  );
}

function CPSOperationalPanel({ cpsId, cps, analytics }) {
  const rows = getOperationalRows(cpsId, cps, analytics);
  return (
    <Section icon={<Activity size={18} />} title="Operational Condition">
      {rows.length ? (
        <div className={styles.fields}>
          {rows.map((row) => (
            <Field key={row.label} label={row.label} value={row.value} />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>No operational data available yet.</div>
      )}
    </Section>
  );
}

function CPSHealthPanel({ cps, analytics }) {
  const rows = metricRows({ cps, analytics }, [
    { label: 'Health Score', paths: ['cps.health.score', 'cps.globalState.healthScore'] },
    { label: 'Health Status', paths: ['cps.health.label', 'cps.globalState.healthLabel'] },
    { label: 'Condition', paths: ['cps.health.condition', 'analytics.health.condition'] },
    { label: 'Risk', paths: ['cps.health.risk', 'analytics.risk', 'analytics.riskLevel', 'analytics.learning.riskLevel'] },
    { label: 'Last Health Update', paths: ['cps.health.lastUpdate'], formatter: formatDate },
  ]);

  if (!rows.length) return null;

  return (
    <Section icon={<HeartPulse size={18} />} title="Health">
      <div className={styles.fields}>
        {rows.map((row) => (
          <Field key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
    </Section>
  );
}

function CPSLearningPanel({ analytics, adaptiveIntelligence }) {
  const learning = analytics?.learning || {};
  const rows = metricRows({ analytics, learning }, [
    { label: 'Learning State', paths: ['learning.learningState', 'learning.state', 'learning.type', 'analytics.learningState'] },
    { label: 'Pattern', paths: ['learning.pattern', 'learning.learningPattern', 'learning.learned', 'analytics.learningPattern'] },
    { label: 'Drift', paths: ['learning.drift', 'learning.driftScore', 'analytics.driftScore'] },
    { label: 'Anomaly', paths: ['learning.anomaly', 'learning.anomalyScore', 'analytics.anomalyScore'] },
    { label: 'Trend', paths: ['learning.trend', 'analytics.trend'] },
  ]);
  const evidence = analytics?.evidence || learning?.evidence || learning?.basis || analytics?.timeSeriesFeatures?.quickSignals;
  const evidenceRows = getEvidenceRows(analytics, learning);

  return (
    <Section icon={<Brain size={18} />} title="Learning">
      <div className={styles.toolbar}>
        <HistoryRecordsButton level="level1" />
      </div>
      {rows.length ? (
        <div className={styles.fields}>
          {rows.map((row) => (
            <Field key={row.label} label={row.label} value={row.value} />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>No learning data available yet.</div>
      )}
      {evidenceRows.length ? <EvidenceGrid rows={evidenceRows} /> : <TextBlock label="Evidence" value={evidence} />}
      <div className={styles.timelineBox}>
        <AdaptiveTimeline
          title="Adaptive Timeline"
          items={adaptiveIntelligence?.adaptiveTimelineCps || []}
          emptyText="No CPS adaptive history yet."
        />
      </div>
    </Section>
  );
}

function CPSReasoningPanel({ analytics }) {
  const reasoning = analytics?.reasoning || {};
  const losses = reasoning?.losses || {};
  const rows = metricRows({ reasoning, losses }, [
    { label: 'Dominant Loss', paths: ['reasoning.dominantLoss'] },
    { label: 'Availability Loss', paths: ['losses.availability', 'reasoning.availabilityLoss'], formatter: formatPct },
    { label: 'Performance Loss', paths: ['losses.performance', 'reasoning.performanceLoss'], formatter: formatPct },
    { label: 'Quality Loss', paths: ['losses.quality', 'reasoning.qualityLoss'], formatter: formatPct },
  ]);

  return (
    <Section icon={<Route size={18} />} title="Reasoning">
      {rows.length ? (
        <div className={styles.fields}>
          {rows.map((row) => (
            <Field key={row.label} label={row.label} value={row.value} />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>No reasoning metrics available yet.</div>
      )}
      <TextBlock label="Explanation" value={reasoning?.explanation} />
      <TextBlock label="Root Cause / Evidence" value={reasoning?.probableCause || reasoning?.evidence || reasoning?.supportingEvidence || analytics?.evidence} />
    </Section>
  );
}

function CPSPredictionPanel({ analytics }) {
  const prediction = analytics?.prediction || {};
  const predictedOEE = firstNumericValue(
    prediction?.predictedOEE,
    prediction?.predictedOee,
    analytics?.predictedOEE,
    analytics?.predictedOee,
    prediction?.forecastOEE,
    analytics?.forecastOEE,
    prediction?.forecast,
    analytics?.forecast
  );
  const rows = [
    { label: 'Predicted OEE', value: formatPct(predictedOEE) },
    { label: 'Trend', value: text(prediction?.trend || analytics?.trend) },
    {
      label: 'Confidence',
      value: hasValue(prediction?.confidence)
        ? formatNumber(prediction.confidence)
        : formatNumber(analytics?.learning?.confidence),
    },
  ];

  return (
    <Section icon={<BarChart3 size={18} />} title="Prediction" className={styles.compactSection}>
      <div className={styles.fields}>
        {rows.map((row) => (
          <Field key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
    </Section>
  );
}

function CPSRecommendationPanel({ analytics }) {
  const source = analytics?.recommendation && typeof analytics.recommendation === 'object'
    ? analytics.recommendation
    : {};
  const recommendation =
    (typeof analytics?.recommendation === 'string' ? analytics.recommendation : null) ||
    source?.recommendation ||
    analytics?.reasoning?.recommendation ||
    analytics?.learning?.recommendation;
  const recommendedAction =
    source?.recommendedAction ||
    source?.action ||
    analytics?.reasoning?.recommendedAction ||
    analytics?.reasoning?.action ||
    analytics?.learning?.recommendedAction ||
    analytics?.learning?.action;
  const rationale = source?.rationale || analytics?.reasoning?.rationale || analytics?.learning?.rationale;
  const recommendationText = text(recommendation);
  const actionText =
    hasValue(recommendedAction) && compactTextValue(recommendedAction) !== recommendationText
      ? compactTextValue(recommendedAction)
      : DASH;
  const rows = [
    { label: 'Recommendation', value: recommendationText, wide: true },
    { label: 'Recommended Action', value: actionText },
    { label: 'Rationale', value: compactTextValue(rationale), wide: true },
  ];

  return (
    <Section icon={<Lightbulb size={18} />} title="Recommendation" className={styles.compactSection}>
      <div className={styles.fields}>
        {rows.map((row) => (
          <Field key={row.label} label={row.label} value={row.value} wide={row.wide} />
        ))}
      </div>
    </Section>
  );
}

function CPSCognitiveTrace({ cpsId, className = '' }) {
  const [state, setState] = useState({ loading: true, error: '', episode: null });

  const loadTrace = useCallback(async (signal) => {
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await fetch('/api/hcm/episodes', { cache: 'no-store', signal });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error || 'Failed to load HCM episodes.');
      const episodes = Array.isArray(json?.episodes) ? json.episodes : [];
      const normalized = String(cpsId || '').toLowerCase();
      const episodeSummary =
        episodes.find((item) => {
          const haystack = JSON.stringify(item || {}).toLowerCase();
          return (
            String(item?.targetCps || '').toLowerCase() === normalized ||
            haystack.includes(`"${normalized}"`) ||
            haystack.includes(normalized)
          );
        }) || null;
      if (!episodeSummary?.episodeId) {
        setState({ loading: false, error: '', episode: episodeSummary });
        return;
      }

      const detailResponse = await fetch(`/api/hcm/episode/${episodeSummary.episodeId}`, {
        cache: 'no-store',
        signal,
      });
      const detailJson = await detailResponse.json().catch(() => null);
      const episode = detailResponse.ok ? detailJson?.episode || episodeSummary : episodeSummary;
      setState({ loading: false, error: '', episode });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setState({ loading: false, error: error?.message || 'Failed to load HCM episodes.', episode: null });
    }
  }, [cpsId]);

  useEffect(() => {
    const controller = new AbortController();
    loadTrace(controller.signal);
    return () => controller.abort();
  }, [loadTrace]);

  if (state.loading) {
    return (
      <Section icon={<Brain size={18} />} title="HCM / Cognitive Trace" className={className}>
        <div className={styles.empty}>Loading HCM trace...</div>
      </Section>
    );
  }

  if (state.error || !state.episode) {
    return null;
  }

  const episode = state.episode;
  const context = episode?.contextSnapshot || {};
  const steps = [
    ['Learning', context?.learning || context?.systemAnalytics?.learningPattern || episode?.trigger],
    ['Reasoning', context?.reasoning || context?.systemReasoning || episode?.dominantLoss],
    ['Recommendation', episode?.recommendation || context?.recommendation],
    ['Decision', episode?.decision || episode?.action || episode?.strategy],
    ['Feedback', episode?.feedback || episode?.status],
    ['Effectiveness', episode?.effectiveness || episode?.result || episode?.closedAt],
  ];

  return (
    <Section icon={<Brain size={18} />} title="HCM / Cognitive Trace" className={className}>
      <div className={styles.trace}>
        {steps.map(([label, value], index) => (
          <React.Fragment key={label}>
            <div className={cx(styles.traceStep, index < steps.length - 1 && styles.traceStepLinked)}>
              <span className={styles.fieldLabel}>{label}</span>
              <strong className={styles.fieldValue}>{compactTextValue(value)}</strong>
            </div>
          </React.Fragment>
        ))}
      </div>
    </Section>
  );
}

export default function CPSDashboard({
  cpsId,
  cps,
  analytics = {},
  adaptiveIntelligence,
  getCanonicalOperationalState,
}) {
  const canonicalOperationalState =
    getOperationalStateFromContext(cps, getCanonicalOperationalState);

  const hasAnalytics = hasObject(analytics);

  return (
    <div className={styles.dashboard}>
      <CPSHeader
        cps={cps}
        cpsId={cpsId}
        analytics={analytics}
        canonicalOperationalState={canonicalOperationalState}
      />
      <CPSKpiGrid cps={cps} analytics={analytics} />
      <div className={styles.grid}>
        <CPSOperationalPanel cpsId={cpsId} cps={cps} analytics={analytics} />
        <CPSHealthPanel cps={cps} analytics={analytics} />
        {hasAnalytics ? (
          <>
            <CPSLearningPanel analytics={analytics} adaptiveIntelligence={adaptiveIntelligence} />
            <CPSReasoningPanel analytics={analytics} />
            <CPSPredictionPanel analytics={analytics} />
            <CPSRecommendationPanel analytics={analytics} />
          </>
        ) : (
          <Section icon={<Brain size={18} />} title="Local Adaptive Intelligence">
            <div className={styles.empty}>Awaiting MQTT analytics telemetry for this CPS.</div>
          </Section>
        )}
        <CPSCognitiveTrace cpsId={cpsId} className={styles.sectionFull} />
      </div>
    </div>
  );
}
