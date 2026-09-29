'use client';

import React from 'react';
import {
  Brain,
  Activity,
  Gauge,
  ShieldCheck,
  TrendingUp,
  AlertTriangle,
  FlaskConical,
  BarChart3,
  Cpu,
  CheckCircle2,
  TimerReset,
  RotateCcw,
  Wrench,
  Thermometer,
  LineChart,
} from 'lucide-react';
import AdaptiveTimeline from './AdaptiveTimeline';
import HistoryRecordsButton from './HistoryRecordsButton';
import { sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';

const DASH = '-';

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const txt = (value, fallback = DASH) => sanitizeTextEncoding(value, { fallback });

const fmtPct = (value, multiply = true) => {
  const n = toNumber(value);
  if (n === null) return DASH;
  const normalized = multiply ? n * 100 : n;
  return `${normalized.toFixed(1)}%`;
};

const fmtNum = (value, digits = 2) => {
  const n = toNumber(value);
  if (n === null) return DASH;
  return n.toFixed(digits);
};

const fmtDate = (value) => {
  if (!value) return DASH;
  try {
    return new Date(value).toLocaleString('pt-BR');
  } catch {
    return DASH;
  }
};

const getOeeValue = (oee, statistics) =>
  toNumber(oee?.oee) ?? toNumber(oee?.value) ?? toNumber(statistics?.oee_mean) ?? null;

const getStatusMeta = (value) => {
  const n = toNumber(value);
  if (n === null) {
    return {
      label: 'No data available',
      tone: 'neutral',
      color: '#64748b',
      bg: '#f8fafc',
      border: '#e2e8f0',
      strong: '#94a3b8',
    };
  }
  if (n >= 0.85) {
    return { label: 'Excelente', tone: 'good', color: '#166534', bg: '#f0fdf4', border: '#bbf7d0', strong: '#16a34a' };
  }
  if (n >= 0.6) {
    return { label: 'Bom', tone: 'warn', color: '#92400e', bg: '#fffbeb', border: '#fde68a', strong: '#d97706' };
  }
  if (n >= 0.4) {
    return { label: 'Moderado', tone: 'mid', color: '#334155', bg: '#f8fafc', border: '#cbd5e1', strong: '#64748b' };
  }
  return { label: 'Critical', tone: 'bad', color: '#991b1b', bg: '#fef2f2', border: '#fecaca', strong: '#dc2626' };
};

const getDominantLossLabel = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'availability') return 'Availability';
  if (normalized === 'performance') return 'Performance';
  if (normalized === 'quality') return 'Qualidade';
  return DASH;
};

const getConfidenceMeta = (value) => {
  const n = toNumber(value);
  if (n === null) return { label: DASH, color: '#475569', bg: '#e2e8f0' };
  if (n >= 0.8) return { label: 'Alta', color: '#166534', bg: '#dcfce7' };
  if (n >= 0.6) return { label: 'Medium', color: '#92400e', bg: '#fef3c7' };
  return { label: 'Baixa', color: '#991b1b', bg: '#fee2e2' };
};

const getSystemHealthBadge = (oeeValue, confidence, dominantLoss) => {
  const oee = toNumber(oeeValue);
  const conf = toNumber(confidence);
  const loss = String(dominantLoss || '').toLowerCase();

  if (oee === null) return { label: 'Unknown', bg: '#e2e8f0', color: '#334155', border: '#cbd5e1' };
  if (oee >= 0.85 && (conf === null || conf >= 0.6)) {
    return { label: 'Healthy', bg: '#dcfce7', color: '#166534', border: '#86efac' };
  }
  if (oee >= 0.6) {
    return {
      label: loss === 'performance' ? 'Attention' : 'Stable',
      bg: '#fef3c7',
      color: '#92400e',
      border: '#fcd34d',
    };
  }
  return { label: 'Critical', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
};

const deltaAccent = (value) => {
  const n = toNumber(value);
  if (n === null) return null;
  if (n > 1) return { bg: '#fff7ed', border: '#fdba74', color: '#c2410c' };
  if (n > 0) return { bg: '#fffbeb', border: '#fde68a', color: '#a16207' };
  if (n < 0) return { bg: '#eff6ff', border: '#93c5fd', color: '#1d4ed8' };
  return { bg: '#f8fafc', border: '#e2e8f0', color: '#334155' };
};

const responsiveTwoCol = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16,
};

function PremiumSection({ icon, eyebrow, title, subtitle, children }) {
  return (
    <section
      style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 24,
        padding: 22,
        boxShadow: '0 16px 40px rgba(15,23,42,0.08)',
      }}
    >
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 8 }}>
          {icon}
          <span>{eyebrow}</span>
        </div>
        <h3 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#0f172a' }}>{title}</h3>
        {subtitle ? <div style={{ marginTop: 8, color: '#475569', fontSize: 14, lineHeight: 1.6 }}>{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Sparkline({ values = [] }) {
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (nums.length < 2) {
    return <div style={{ height: 34, borderRadius: 10, background: '#f8fafc', border: '1px dashed #cbd5e1' }} />;
  }

  const width = 160;
  const height = 34;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const points = nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 6) - 3;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

function KpiCard({ icon, label, value, helper, meta, sparkValues = [] }) {
  return (
    <div
      style={{
        border: `1px solid ${meta.border}`,
        background: `linear-gradient(180deg, ${meta.bg} 0%, #ffffff 100%)`,
        borderRadius: 20,
        padding: 18,
        minHeight: 176,
        boxShadow: '0 8px 20px rgba(15,23,42,0.04)',
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#64748b' }}>{label}</div>
        <div style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: '#ffffff', border: `1px solid ${meta.border}`, color: meta.color }}>
          {icon}
        </div>
      </div>
      <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1, color: '#0f172a' }}>{value}</div>
      <Sparkline values={sparkValues} />
      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.5 }}>{helper}</div>
    </div>
  );
}

function InfoChip({ label, bg, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '7px 12px', borderRadius: 999, background: bg, color, fontSize: 12, fontWeight: 800 }}>
      {label}
    </span>
  );
}

function SmallMetric({ label, value, subtle, accent }) {
  return (
    <div style={{ border: `1px solid ${accent?.border || '#e2e8f0'}`, background: accent?.bg || (subtle ? '#f8fafc' : '#ffffff'), borderRadius: 16, padding: 15 }}>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent?.color || '#0f172a' }}>{value}</div>
    </div>
  );
}

function ProgressBar({ value }) {
  const n = toNumber(value);
  const pct = n === null ? 0 : Math.max(0, Math.min(100, n * 100));
  const meta = getStatusMeta(n);
  return (
    <div>
      <div style={{ height: 16, width: '100%', background: '#e2e8f0', borderRadius: 999, overflow: 'hidden', border: '1px solid #cbd5e1' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 999,
            background:
              meta.tone === 'good'
                ? 'linear-gradient(90deg, #22c55e 0%, #16a34a 100%)'
                : meta.tone === 'warn'
                ? 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)'
                : meta.tone === 'mid'
                ? 'linear-gradient(90deg, #94a3b8 0%, #64748b 100%)'
                : meta.tone === 'bad'
                ? 'linear-gradient(90deg, #ef4444 0%, #dc2626 100%)'
                : 'linear-gradient(90deg, #cbd5e1 0%, #94a3b8 100%)',
          }}
        />
      </div>
    </div>
  );
}

function LossBar({ label, value }) {
  const n = toNumber(value) ?? 0;
  const pct = Math.max(0, Math.min(100, n * 100));
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 14, padding: 12, background: '#ffffff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13, color: '#475569', fontWeight: 700 }}>
        <span>{label}</span>
        <span>{fmtPct(n)}</span>
      </div>
      <div style={{ height: 12, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 999,
            background:
              pct >= 50
                ? 'linear-gradient(90deg, #ef4444 0%, #dc2626 100%)'
                : pct >= 20
                ? 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)'
                : 'linear-gradient(90deg, #94a3b8 0%, #64748b 100%)',
          }}
        />
      </div>
    </div>
  );
}

function OeeGauge({ value }) {
  const n = toNumber(value);
  const pct = n === null ? 0 : Math.max(0, Math.min(100, n * 100));
  const meta = getStatusMeta(n);
  const size = 190;
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;

  return (
    <div style={{ display: 'grid', placeItems: 'center', position: 'relative', width: size, height: size, margin: '0 auto' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} stroke="rgba(255,255,255,0.15)" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={radius} stroke={meta.strong} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={`${dash} ${circumference - dash}`} />
      </svg>
      <div style={{ position: 'absolute', textAlign: 'center', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 700 }}>Global OEE</div>
        <div style={{ fontSize: 34, fontWeight: 900, color: '#ffffff', lineHeight: 1 }}>{fmtPct(n)}</div>
        <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 700 }}>{meta.label}</div>
      </div>
    </div>
  );
}

function EvidenceCard({ icon, label, value, accent }) {
  return (
    <div style={{ border: `1px solid ${accent?.border || '#e2e8f0'}`, background: accent?.bg || '#ffffff', borderRadius: 18, padding: 16, minHeight: 112, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div style={{ fontSize: 12, color: '#64748b', fontWeight: 700 }}>{label}</div>
        <div style={{ width: 36, height: 36, borderRadius: 12, display: 'grid', placeItems: 'center', background: '#ffffff', border: `1px solid ${accent?.border || '#e2e8f0'}`, color: accent?.color || '#334155' }}>
          {icon}
        </div>
      </div>
      <div style={{ fontSize: 24, fontWeight: 900, color: accent?.color || '#0f172a' }}>{value}</div>
    </div>
  );
}

export default function CPSAnalyticsPanel({ cpsId, analytics, title, adaptiveIntelligence }) {
  const oee = analytics?.oee || {};
  const learning = analytics?.learning || {};
  const reasoning = analytics?.reasoning || {};
  const statistics = analytics?.statistics || {};
  const evidence =
    analytics?.evidence ||
    learning?.basis ||
    analytics?.basis ||
    analytics?.timeSeriesFeatures?.quickSignals ||
    {};
  const lastUpdate = analytics?.lastUpdate || oee?.ts || null;

  const availability = toNumber(oee?.availability);
  const performance = toNumber(oee?.performance);
  const quality = toNumber(oee?.quality);
  const oeeValue = getOeeValue(oee, statistics);
  const availabilityMeta = getStatusMeta(availability);
  const performanceMeta = getStatusMeta(performance);
  const qualityMeta = getStatusMeta(quality);
  const oeeMeta = getStatusMeta(oeeValue);
  const confidenceMeta = getConfidenceMeta(learning?.confidence);
  const systemHealth = getSystemHealthBadge(oeeValue, learning?.confidence, reasoning?.dominantLoss);
  const adaptiveLearningCps = adaptiveIntelligence?.adaptiveLearningCps || {};
  const adaptiveTimelineCps = Array.isArray(adaptiveIntelligence?.adaptiveTimelineCps)
    ? adaptiveIntelligence.adaptiveTimelineCps
    : [];

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 30,
          padding: 30,
          background:
            'radial-gradient(circle at top right, rgba(59,130,246,0.30), transparent 20%), radial-gradient(circle at bottom left, rgba(16,185,129,0.16), transparent 18%), linear-gradient(135deg, #0f172a 0%, #111827 45%, #1e293b 100%)',
          boxShadow: '0 28px 70px rgba(15,23,42,0.22)',
          color: '#ffffff',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'center' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.14)', marginBottom: 14, fontSize: 12, fontWeight: 800, color: '#e2e8f0' }}>
              <Cpu size={14} />
              ACSM ANALYTICS
            </div>
            <h2 style={{ margin: 0, fontSize: 36, lineHeight: 1.06, fontWeight: 900 }}>{txt(title, 'Analytics')}</h2>
            <div style={{ marginTop: 10, color: '#cbd5e1', fontSize: 15, lineHeight: 1.7 }}>
              Analytical asset dashboard for <strong style={{ color: '#fff' }}>{txt(cpsId, DASH)}</strong>, with consolidated OEE, learning, reasoning, and operational evidence.
            </div>
            <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <InfoChip label={`Status ${oeeMeta.label}`} bg="rgba(255,255,255,0.12)" color="#ffffff" />
              <InfoChip label={`Confidence ${confidenceMeta.label}`} bg="rgba(255,255,255,0.12)" color="#ffffff" />
              <InfoChip label={`Health ${systemHealth.label}`} bg={systemHealth.bg} color={systemHealth.color} />
              <InfoChip label={`Ultima leitura ${fmtDate(lastUpdate)}`} bg="rgba(255,255,255,0.12)" color="#ffffff" />
            </div>
          </div>

          <div style={{ borderRadius: 24, padding: 20, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', display: 'grid', gap: 12, alignItems: 'center' }}>
            <OeeGauge value={oeeValue} />
            <div style={{ color: '#cbd5e1', fontSize: 13, textAlign: 'center' }}>
              Current classification: <strong style={{ color: '#fff' }}>{oeeMeta.label}</strong>
            </div>
            <ProgressBar value={oeeValue} />
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <KpiCard icon={<ShieldCheck size={18} />} label="Availability" value={fmtPct(availability)} helper="Effective time available for production." meta={availabilityMeta} sparkValues={[statistics?.availability_mean, statistics?.availability_median, availability]} />
        <KpiCard icon={<Gauge size={18} />} label="Performance" value={fmtPct(performance)} helper="Operational efficiency against the expected cycle." meta={performanceMeta} sparkValues={[statistics?.performance_mean, statistics?.performance_median, performance]} />
        <KpiCard icon={<CheckCircle2 size={18} />} label="Quality" value={fmtPct(quality)} helper="Rate of conforming parts in the process." meta={qualityMeta} sparkValues={[statistics?.quality_mean, statistics?.quality_median, quality]} />
        <KpiCard icon={<TrendingUp size={18} />} label="Global OEE" value={fmtPct(oeeValue)} helper={`Current classification: ${oeeMeta.label}`} meta={oeeMeta} sparkValues={[statistics?.oee_mean, statistics?.oee_median, oeeValue]} />
      </div>

      <PremiumSection icon={<Activity size={15} />} eyebrow="ADAPTIVE INTELLIGENCE" title="Local Adaptive Intelligence" subtitle="Short-window adaptive memory for this CPS asset.">
        <div style={{ marginBottom: 12 }}>
          <HistoryRecordsButton level="level1" />
        </div>
        <div style={responsiveTwoCol}>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 20, padding: 18, background: '#ffffff', display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#0f172a' }}>CPS Adaptive State</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, color: '#475569', fontSize: 13, lineHeight: 1.5 }}>
              <div>Temporal State: <strong>{txt(adaptiveLearningCps?.temporalState)}</strong></div>
              <div>Adaptive Action: <strong>{txt(adaptiveLearningCps?.adaptiveAction)}</strong></div>
              <div>Strategy Class: <strong>{txt(adaptiveLearningCps?.strategyClass)}</strong></div>
              <div>Effectiveness: <strong>{txt(adaptiveLearningCps?.interventionEffectiveness)}</strong></div>
            </div>
            <div style={{ color: '#64748b', fontSize: 13, lineHeight: 1.6 }}>
              {txt(adaptiveLearningCps?.adaptiveReason, 'No CPS adaptive state available yet.')}
            </div>
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 20, padding: 18, background: '#ffffff' }}>
            <AdaptiveTimeline
              title="Adaptive Timeline (CPS)"
              items={adaptiveTimelineCps}
              emptyText="No CPS adaptive history yet."
            />
          </div>
        </div>
      </PremiumSection>

      <PremiumSection icon={<Brain size={15} />} eyebrow="ANALYTICAL INTELLIGENCE" title="Executive Learning Summary" subtitle="Summary of local statistical learning, recent behavior interpretation, and operational recommendation.">
        <div style={responsiveTwoCol}>
          <div style={{ border: '1px solid #dbeafe', background: 'linear-gradient(180deg, #eff6ff 0%, #ffffff 100%)', borderRadius: 20, padding: 18 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Learning Type</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#0f172a', marginBottom: 10 }}>{txt(learning?.type, 'No classification received')}</div>
            <div style={{ color: '#334155', lineHeight: 1.8, fontSize: 15, marginBottom: 16 }}>
              {txt(learning?.learned, 'No learning summary was received.')}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <InfoChip label={`Model: ${txt(learning?.model, DASH)}`} bg="#dbeafe" color="#1d4ed8" />
              <InfoChip label={`Confidence: ${fmtNum(learning?.confidence, 2)}`} bg={confidenceMeta.bg} color={confidenceMeta.color} />
            </div>
          </div>
          <div style={{ border: '1px solid #ede9fe', background: 'linear-gradient(180deg, #f5f3ff 0%, #ffffff 100%)', borderRadius: 20, padding: 18 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Recommended Action</div>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.7, color: '#0f172a' }}>
              {txt(learning?.recommendation || reasoning?.recommendation, 'No operational recommendation available.')}
            </div>
          </div>
        </div>
      </PremiumSection>

      <PremiumSection icon={<FlaskConical size={15} />} eyebrow="EVIDENCE" title="Evidence Against Local Baseline" subtitle="Percentage variations detected in observed variables compared with reference behavior.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <EvidenceCard label="Cycle Delta" value={fmtPct(evidence?.cycleDeltaPct)} accent={deltaAccent(evidence?.cycleDeltaPct)} icon={<TimerReset size={18} />} />
          <EvidenceCard label="RPM Delta" value={fmtPct(evidence?.rpmDeltaPct)} accent={deltaAccent(evidence?.rpmDeltaPct)} icon={<RotateCcw size={18} />} />
          <EvidenceCard label="Torque Delta" value={fmtPct(evidence?.torqueDeltaPct)} accent={deltaAccent(evidence?.torqueDeltaPct)} icon={<Wrench size={18} />} />
          <EvidenceCard label="Temperature Delta" value={fmtPct(evidence?.temperatureDeltaPct ?? evidence?.tempDeltaPct)} accent={deltaAccent(evidence?.temperatureDeltaPct ?? evidence?.tempDeltaPct)} icon={<Thermometer size={18} />} />
          <EvidenceCard label="OEE Delta" value={fmtPct(evidence?.oeeDeltaPct)} accent={deltaAccent(evidence?.oeeDeltaPct)} icon={<LineChart size={18} />} />
        </div>
      </PremiumSection>

      <PremiumSection icon={<AlertTriangle size={15} />} eyebrow="ANALYTICAL REASONING" title="Root-Cause Reasoning" subtitle="Causal reading of the primary OEE loss and technical investigation recommendation.">
        <div style={responsiveTwoCol}>
          <div style={{ border: '1px solid #fee2e2', background: 'linear-gradient(180deg, #fff7ed 0%, #ffffff 100%)', borderRadius: 20, padding: 18 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Dominant Loss</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: '#0f172a', marginBottom: 16 }}>{getDominantLossLabel(reasoning?.dominantLoss)}</div>
            <div style={{ display: 'grid', gap: 12 }}>
              <LossBar label="Loss - Availability" value={reasoning?.losses?.availability} />
              <LossBar label="Loss - Performance" value={reasoning?.losses?.performance} />
              <LossBar label="Loss - Quality" value={reasoning?.losses?.quality} />
            </div>
          </div>
          <div style={{ border: '1px solid #e2e8f0', background: '#ffffff', borderRadius: 20, padding: 18 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Explanation</div>
            <div style={{ color: '#334155', fontSize: 15, lineHeight: 1.85, marginBottom: 18 }}>
              {txt(reasoning?.explanation, 'No explanation received.')}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Technical Recommendation</div>
            <div style={{ fontWeight: 800, color: '#0f172a', fontSize: 16, lineHeight: 1.7 }}>
              {txt(reasoning?.recommendation, 'No recommendation received.')}
            </div>
          </div>
        </div>
      </PremiumSection>

      <PremiumSection icon={<BarChart3 size={15} />} eyebrow="STATISTICS" title="Statistical Consolidation" subtitle="Summary of means and medians for the main indicators calculated by the analytics module.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
          <SmallMetric label="Availability Mean" value={fmtPct(statistics?.availability_mean)} />
          <SmallMetric label="Availability Median" value={fmtPct(statistics?.availability_median)} />
          <SmallMetric label="Performance Mean" value={fmtPct(statistics?.performance_mean)} />
          <SmallMetric label="Performance Median" value={fmtPct(statistics?.performance_median)} />
          <SmallMetric label="Quality Mean" value={fmtPct(statistics?.quality_mean)} />
          <SmallMetric label="Quality Median" value={fmtPct(statistics?.quality_median)} />
          <SmallMetric label="OEE Mean" value={fmtPct(statistics?.oee_mean)} />
          <SmallMetric label="OEE Median" value={fmtPct(statistics?.oee_median)} />
        </div>
      </PremiumSection>

      <PremiumSection icon={<Activity size={15} />} eyebrow="EXECUTIVE OBSERVATION" title="Operational Interpretation" subtitle="Text summary ready for dashboard, review panel, or technical presentation.">
        <div style={{ borderRadius: 22, padding: 22, background: 'linear-gradient(135deg, #f8fafc 0%, #ffffff 100%)', border: '1px solid #dbeafe', color: '#334155', lineHeight: 1.95, fontSize: 15 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', color: '#1d4ed8', marginBottom: 10, textTransform: 'uppercase' }}>
            Executive Note
          </div>
          The asset <strong>{txt(cpsId, DASH)}</strong> shows <strong>Availability of {fmtPct(availability)}</strong>, <strong>Performance of {fmtPct(performance)}</strong> and <strong>Quality of {fmtPct(quality)}</strong>, resulting in a <strong>Global OEE of {fmtPct(oeeValue)}</strong>, classified as <strong>{oeeMeta.label}</strong>. The learning module indicates <strong>{txt(learning?.learned, 'no relevant conclusion')}</strong>, with Confidence <strong>{fmtNum(learning?.confidence, 2)}</strong>. The primary identified loss is associated with <strong>{getDominantLossLabel(reasoning?.dominantLoss)}</strong>, suggesting analysis focus on <strong>{txt(reasoning?.recommendation, 'additional operational investigation')}</strong>.
        </div>
      </PremiumSection>
    </div>
  );
}
