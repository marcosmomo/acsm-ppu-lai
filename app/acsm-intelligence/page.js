'use client';

import React from 'react';
import { useCPSContext } from '../../context/CPSContext';
import {
  ExecutiveApqChart,
  ExecutiveOeeTrendChart,
  ExecutiveRankingChart,
} from '../../components/ExecutiveAnalyticsCharts';

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(Math.max(numeric, 0), 1);
}

function pct(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return `${(numeric * 100).toFixed(digits)}%`;
}

function safeNum(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return numeric.toFixed(digits);
}

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function upper(value, fallback = '') {
  const text = safeText(value, fallback);
  return text ? text.toUpperCase() : fallback;
}

function titleCase(value) {
  const text = safeText(value);
  if (!text) return '';
  return text
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function humanizeToken(value) {
  return titleCase(safeText(value).replace(/[_-]+/g, ' '));
}

function normalizeRisk(value) {
  const risk = String(value || '').toLowerCase();
  if (risk === 'high' || risk === 'medium' || risk === 'low') return risk;
  return 'medium';
}

function getRiskTone(level) {
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  if (level === 'low') return 'low';
  return 'neutral';
}

function getRiskLabel(level) {
  return upper(level, 'MEDIUM');
}

function getSystemStateLabel({ riskLevel, stabilityIndex, learningPattern }) {
  const risk = normalizeRisk(riskLevel);
  const pattern = String(learningPattern || '').toLowerCase();

  if (risk === 'high') return 'UNSTABLE';
  if (Number.isFinite(stabilityIndex) && stabilityIndex < 0.55) return 'UNSTABLE';
  if (
    pattern.includes('unstable') ||
    pattern.includes('drift') ||
    pattern.includes('degrading') ||
    pattern.includes('cascade')
  ) {
    return 'UNSTABLE';
  }
  return 'STABLE';
}

function translatePattern(value) {
  const normalized = String(value || '').toLowerCase();
  const dictionary = {
    chronic_availability_loss: 'Availability loss',
    persistent_availability_loss: 'Systemic availability issue',
    chronic_performance_loss: 'System Performance ofgradation',
    chronic_quality_loss: 'Quality loss',
    degrading_system: 'System degradation',
    recovering_system: 'System recovery',
    unstable_oscillation: 'Operational instability',
    stable_system: 'Stable system',
    desynchronization_pattern: 'Synchronization issue',
    propagating_loss_pattern: 'Propagation risk',
    degraded_global_pattern: 'System Performance ofgradation',
    mixed_operational_pattern: 'Mixed operating condition',
    stable_high_performance: 'Stable performance',
    stable_moderate_performance: 'Moderate stability',
    insufficient_history: 'Limited history',
  };

  return dictionary[normalized] || humanizeToken(normalized);
}

function translateLoss(value) {
  const normalized = String(value || '').toLowerCase();
  const dictionary = {
    availability: 'Availability loss',
    performance: 'System Performance ofgradation',
    quality: 'Quality loss',
    unknown: 'Operational imbalance',
  };

  return dictionary[normalized] || translatePattern(normalized);
}

function getPrimaryIssue({ dominantLosses, learningPattern, riskDrivers }) {
  const dominantLoss = Array.isArray(dominantLosses) ? dominantLosses[0] : null;
  const dominantDimension = dominantLoss?.dominantDimension || dominantLoss?.dominantLoss;
  if (dominantDimension) return translateLoss(dominantDimension);

  const translatedPattern = translatePattern(learningPattern);
  if (translatedPattern) return translatedPattern;

  const firstRiskDriver = Array.isArray(riskDrivers) ? safeText(riskDrivers[0]) : '';
  if (firstRiskDriver) return humanizeToken(firstRiskDriver);

  return 'Monitor system condition';
}

function getPropagationRiskLabel(analytics, riskLevel) {
  const propagation = safeText(
    analytics?.propagationRisk ||
      analytics?.lossPropagation?.propagationRisk ||
      analytics?.lossPropagation?.riskLevel
  ).toLowerCase();

  if (propagation === 'high' || analytics?.lossPropagation?.detected) return 'HIGH';
  if (propagation === 'medium') return 'MEDIUM';
  if (propagation === 'low') return 'LOW';
  return getRiskLabel(riskLevel);
}

function estimateExpectedImpact({ riskLevel, globalOee }) {
  const risk = normalizeRisk(riskLevel);
  const oee = Number(globalOee);

  if (risk === 'high') {
    return oee < 0.6
      ? 'Stabilize throughput and recover availability'
      : 'Contain systemic losses';
  }
  if (risk === 'medium') return 'Recover localized efficiency and prevent escalation';
  return 'Sustain current performance baseline';
}

function buildExecutiveActionPlan({ analytics, riskLevel, criticalCpsId, bottleneckCpsId }) {
  const actionPlan = analytics?.coordinationActionPlan || analytics?.actionPlan || {};
  const focus =
    safeText(
      actionPlan?.recommendedFocus ||
        analytics?.recommendedFocus ||
        analytics?.mostCriticalAcsm ||
        analytics?.criticalCoordinationPoint?.acsmId
    ) || '';
  const targetCps =
    safeText(
      actionPlan?.targetCps ||
        criticalCpsId ||
        bottleneckCpsId ||
        analytics?.bottleneck?.cpsId ||
        analytics?.bottleneckCps
    ) || '-';
  const priority = upper(normalizeRisk(riskLevel) === 'high' ? 'high' : 'medium');
  const expectedImpact =
    safeText(actionPlan?.expectedImpact) ||
    estimateExpectedImpact({
      riskLevel,
      globalOee:
        analytics?.globalSummary?.overallOee ??
        analytics?.globalOEE?.oee ??
        analytics?.oee?.oee,
    });

  return {
    focus,
    targetCps,
    priority,
    expectedImpact,
  };
}

function getOeeTrendSignal(data) {
  const lastValue = Number(data?.at(-1)?.oee);
  const previousValue = Number(data?.at(-2)?.oee);
  if (!Number.isFinite(lastValue) || !Number.isFinite(previousValue)) return null;

  const delta = lastValue - previousValue;
  if (Math.abs(delta) < 0.0005) {
    return { symbol: '→', tone: 'neutral', label: 'stable' };
  }

  return delta > 0
    ? { symbol: '↑', tone: 'low', label: 'improving' }
    : { symbol: '↓', tone: 'high', label: 'declining' };
}

function buildDecisionContext({ riskLevel, primaryIssue, criticalZone, propagationRisk }) {
  if (normalizeRisk(riskLevel) === 'high') {
    return `Immediate intervention required in ${criticalZone}.`;
  }
  if (propagationRisk === 'HIGH') {
    return 'Instability may spread beyond the current critical zone.';
  }
  if (primaryIssue) {
    return `${primaryIssue} concentrated in ${criticalZone}.`;
  }
  return 'Throughput instability detected across critical zone.';
}

function getTopRanking(ranking) {
  return Array.isArray(ranking) ? ranking.filter(Boolean).slice(0, 3) : [];
}

function buildOeeTrendData(historySummary) {
  const series = Array.isArray(historySummary?.oeeSeries) ? historySummary.oeeSeries : [];

  return series
    .map((item, index) => {
      const oee = Number(item?.oee ?? item?.value ?? item);
      if (!Number.isFinite(oee)) return null;

      return {
        label: item?.label || `T${index + 1}`,
        oee,
      };
    })
    .filter(Boolean)
    .slice(-8);
}

function buildApqChartData({ availability, performance, quality }) {
  return [
    { label: 'Availability', value: availability, color: '#9b3d2f' },
    { label: 'Performance', value: performance, color: '#c98e27' },
    { label: 'Quality', value: quality, color: '#1f8a61' },
  ].filter((entry) => Number.isFinite(Number(entry.value)));
}

/*
function buildRankingChartData(ranking) {
  const colors = ['#9b3d2f', '#c98e27', '#1f8a61'];

  return ranking
    .map((item, index) => {
      const score = Number(item?.score);
      if (!Number.isFinite(score)) return null;

      const fullLabel = safeText(item?.cpsId || item?.cpsName, `CPS ${index + 1}`);
      return {
        label: fullLabel,
        fullLabel,
        score,
        color: colors[index] || '#7f93a3',
      };
    })
    .filter(Boolean);
}*/

function buildRankingChartData(ranking) {
  const colors = ['#9b3d2f', '#c98e27', '#1f8a61'];

  return ranking
    .map((item, index) => {
      const score = Number(item?.score);
      if (!Number.isFinite(score)) return null;

      const label = safeText(item?.cpsId || item?.cpsName, `CPS ${index + 1}`);

      return {
        label,
        fullLabel: label,
        value: score,   // 🔥 ESSENCIAL
        score: score,   // keeps compatibility
        color: colors[index] || '#7f93a3',
      };
    })
    .filter(Boolean);
}

function getFallbackOeeTrendData(globalOee) {
  const base = Number.isFinite(Number(globalOee)) ? Number(globalOee) : 0.58;
  const t1 = Math.max(0, Math.min(1, base + 0.06));
  const t2 = Math.max(0, Math.min(1, base + 0.02));
  const t3 = Math.max(0, Math.min(1, base));

  return [
    { label: 'T1', oee: Number(t1.toFixed(3)) },
    { label: 'T2', oee: Number(t2.toFixed(3)) },
    { label: 'T3', oee: Number(t3.toFixed(3)) },
  ];
}

function getFallbackApqChartData({ availability, performance, quality }) {
  return [
    {
      label: 'Availability',
      value: Number.isFinite(Number(availability)) ? Number(availability) : 0.74,
      color: '#9b3d2f',
    },
    {
      label: 'Performance',
      value: Number.isFinite(Number(performance)) ? Number(performance) : 0.68,
      color: '#c98e27',
    },
    {
      label: 'Quality',
      value: Number.isFinite(Number(quality)) ? Number(quality) : 0.86,
      color: '#1f8a61',
    },
  ];
}

function StatCard({ label, value, tone = 'neutral', accent = false, note }) {
  return (
    <div className={`stat-card ${tone} ${accent ? 'accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value || ' '}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

function DetailRow({ label, value, tone = 'neutral' }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className={`detail-value ${tone}`}>{value || ' '}</span>
    </div>
  );
}

function MiniBar({ label, value, tone = 'neutral' }) {
  const width = Number.isFinite(Number(value))
    ? `${Math.max(6, Math.min(Number(value) * 100, 100))}%`
    : '0%';

  return (
    <div className="mini-bar">
      <div className="mini-bar-head">
        <span>{label}</span>
        <strong>{pct(value)}</strong>
      </div>
      <div className="mini-bar-track">
        <div className={`mini-bar-fill ${tone}`} style={{ width }} />
      </div>
    </div>
  );
}

export default function ACSMIntelligencePage() {
  const { stableSystemAnalytics, level3RuntimeStatus } = useCPSContext();
  const analytics = stableSystemAnalytics || {};

  const availability = clamp01(
    analytics?.globalSummary?.overallAvailability ??
      analytics?.availability ??
      analytics?.globalOEE?.availability
  );
  const performance = clamp01(
    analytics?.globalSummary?.overallPerformance ??
      analytics?.performance ??
      analytics?.globalOEE?.performance
  );
  const quality = clamp01(
    analytics?.globalSummary?.overallQuality ??
      analytics?.quality ??
      analytics?.globalOEE?.quality
  );
  const globalOee = clamp01(
    analytics?.globalSummary?.overallOee ??
      analytics?.globalOEE?.oee ??
      analytics?.oee?.oee ??
      analytics?.oee ??
      (availability != null && performance != null && quality != null
        ? availability * performance * quality
        : null)
  );

  const riskLevel = normalizeRisk(
    analytics?.riskLevel || analytics?.riskSummary?.level || analytics?.predictedRisk?.level
  );
  const learningPattern = safeText(
    analytics?.learningPattern || analytics?.learnedPattern || analytics?.systemPattern
  );
  const systemState = getSystemStateLabel({
    riskLevel,
    stabilityIndex: analytics?.stabilityIndex,
    learningPattern,
  });

  const mostCriticalAcsm = safeText(
    analytics?.mostCriticalAcsm || analytics?.criticalCoordinationPoint?.acsmId
  );
  const criticalCpsId = safeText(
    analytics?.criticalCPS?.cpsId || analytics?.criticalCps || analytics?.criticalCPS
  );
  const bottleneckCpsId = safeText(
    analytics?.bottleneck?.cpsId || analytics?.bottleneckCps || analytics?.bottleneck
  );

  const dominantLosses = Array.isArray(analytics?.dominantLosses) ? analytics.dominantLosses : [];
  const riskDrivers = Array.isArray(analytics?.riskDrivers) ? analytics.riskDrivers : [];
  const topRanking = getTopRanking(
    Array.isArray(analytics?.cpsContributionRanking) ? analytics.cpsContributionRanking : []
  );
  const primaryIssue = getPrimaryIssue({
    dominantLosses,
    learningPattern,
    riskDrivers,
  });
  const propagationRisk = getPropagationRiskLabel(analytics, riskLevel);
  const executiveActionPlan = buildExecutiveActionPlan({
    analytics,
    riskLevel,
    criticalCpsId,
    bottleneckCpsId,
  });

  const activeParticipantsCount =
    analytics?.activeParticipantsCount ?? level3RuntimeStatus?.activeParticipantsCount ?? 0;
  const expectedParticipantsCount =
    analytics?.expectedParticipantsCount ?? level3RuntimeStatus?.expectedParticipantsCount ?? 3;
  const level3Mode = upper(
    analytics?.level3Mode || level3RuntimeStatus?.level3Mode,
    'PARTIAL'
  );
  const translatedLearning = translatePattern(learningPattern);
  const dominantLossLabel = dominantLosses[0]
    ? translateLoss(dominantLosses[0]?.dominantDimension || dominantLosses[0]?.dominantLoss)
    : primaryIssue;

  const historySummary = analytics?.historySummary || {};

  const builtOeeTrendData = buildOeeTrendData(historySummary);
  const oeeTrendData = builtOeeTrendData.length
    ? builtOeeTrendData
    : getFallbackOeeTrendData(globalOee);

  const builtApqChartData = buildApqChartData({ availability, performance, quality });
  const apqChartData = builtApqChartData.length
    ? builtApqChartData
    : getFallbackApqChartData({ availability, performance, quality });

  const builtRankingChartData = buildRankingChartData(topRanking);
  const rankingChartData = builtRankingChartData.length
    ? builtRankingChartData
    : [];

  const oeeTrendSignal = getOeeTrendSignal(oeeTrendData);

  const criticalZone = [mostCriticalAcsm, criticalCpsId].filter(Boolean).join(' | ');
  const decisionContextSummary = buildDecisionContext({
    riskLevel,
    primaryIssue,
    criticalZone,
    propagationRisk,
  });

  const baselineLabel = [pct(availability), pct(performance), pct(quality)]
    .filter(Boolean)
    .join(' / ');

  return (
    <div className="page">
      <style jsx>{`
        .page {
          min-height: 100vh;
          padding: 28px;
          background:
            radial-gradient(circle at top left, rgba(240, 68, 56, 0.12), transparent 24%),
            radial-gradient(circle at top right, rgba(0, 166, 118, 0.12), transparent 22%),
            linear-gradient(180deg, #f6f3ee 0%, #efe7dd 100%);
          color: #14212b;
          font-family: Georgia, 'Times New Roman', serif;
        }
        .shell {
          max-width: 1420px;
          margin: 0 auto;
          display: grid;
          gap: 18px;
        }
        .topbar {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
          padding: 10px 4px;
        }
        .eyebrow {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #7a5b45;
        }
        .title {
          margin: 10px 0 0;
          font-size: 40px;
          line-height: 0.98;
          font-weight: 800;
          color: #11202b;
        }
        .subtitle {
          margin: 10px 0 0;
          max-width: 720px;
          color: #5a6874;
          font-size: 15px;
          line-height: 1.6;
          font-family: Arial, Helvetica, sans-serif;
        }
        .meta {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 10px 14px;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          border: 1px solid transparent;
          background: rgba(255, 255, 255, 0.72);
          color: #24333f;
          font-family: Arial, Helvetica, sans-serif;
        }
        .pill.high {
          background: #4f1411;
          color: #ffe2da;
          border-color: #7a231e;
        }
        .pill.medium {
          background: #5e420c;
          color: #ffe8b3;
          border-color: #86601b;
        }
        .pill.low {
          background: #133d30;
          color: #d6fff0;
          border-color: #1d5f4a;
        }
        .layout {
          display: grid;
          grid-template-columns: 1.04fr 0.96fr;
          gap: 18px;
        }
        .column {
          display: grid;
          gap: 18px;
        }
        .section {
          border-radius: 28px;
          padding: 24px;
          background: rgba(255, 255, 255, 0.74);
          border: 1px solid rgba(98, 82, 68, 0.12);
          box-shadow: 0 20px 40px rgba(77, 58, 43, 0.08);
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: baseline;
          margin-bottom: 18px;
        }
        .section-title {
          margin: 0;
          font-size: 24px;
          line-height: 1;
          font-weight: 800;
          color: #13202a;
        }
        .section-note {
          font-size: 12px;
          color: #6f7c87;
          font-family: Arial, Helvetica, sans-serif;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .status-grid {
          display: grid;
          grid-template-columns: 1.2fr 0.8fr 0.8fr;
          gap: 14px;
        }
        .stat-card {
          border-radius: 22px;
          padding: 18px;
          background: #fffdf9;
          border: 1px solid rgba(84, 69, 56, 0.1);
        }
        .stat-card.accent {
          background: linear-gradient(135deg, #182734 0%, #22384b 100%);
          color: #f8f5ef;
          border-color: rgba(255, 255, 255, 0.08);
        }
        .stat-card.high {
          box-shadow: inset 0 0 0 1px rgba(174, 46, 36, 0.18);
        }
        .stat-card.medium {
          box-shadow: inset 0 0 0 1px rgba(164, 113, 27, 0.18);
        }
        .stat-card.low {
          box-shadow: inset 0 0 0 1px rgba(21, 118, 84, 0.18);
        }
        .stat-label {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: inherit;
          opacity: 0.72;
          font-family: Arial, Helvetica, sans-serif;
        }
        .stat-value {
          margin-top: 10px;
          font-size: 48px;
          line-height: 0.95;
          font-weight: 900;
          color: inherit;
        }
        .stat-value-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .trend-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-family: Arial, Helvetica, sans-serif;
          background: rgba(255,255,255,0.12);
        }
        .trend-chip.high {
          color: #ffd8cf;
          background: rgba(155, 61, 47, 0.22);
        }
        .trend-chip.low {
          color: #d8ffef;
          background: rgba(31, 138, 97, 0.22);
        }
        .trend-chip.neutral {
          color: #e4edf5;
          background: rgba(255,255,255,0.14);
        }
        .stat-note {
          margin-top: 12px;
          font-size: 14px;
          color: inherit;
          opacity: 0.86;
          font-family: Arial, Helvetica, sans-serif;
          line-height: 1.5;
        }
        .detail-grid {
          display: grid;
          gap: 12px;
        }
        .detail-row {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          align-items: center;
          padding: 14px 16px;
          border-radius: 18px;
          background: rgba(248, 244, 237, 0.86);
          border: 1px solid rgba(91, 76, 62, 0.1);
          font-family: Arial, Helvetica, sans-serif;
        }
        .detail-label {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #6f7c87;
        }
        .detail-value {
          font-size: 16px;
          font-weight: 800;
          text-align: right;
          color: #1a2a34;
        }
        .detail-value.high {
          color: #8a1f17;
        }
        .detail-value.medium {
          color: #9b6508;
        }
        .detail-value.low {
          color: #116447;
        }
        .action-center {
          background: linear-gradient(135deg, #1b2a38 0%, #243f53 100%);
          color: #f8f4ee;
          border-color: rgba(255, 255, 255, 0.08);
          box-shadow: 0 22px 46px rgba(17, 32, 43, 0.24);
        }
        .action-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
        }
        .action-card {
          border-radius: 20px;
          padding: 18px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .action-label {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #cfdbe5;
          font-family: Arial, Helvetica, sans-serif;
        }
        .action-value {
          margin-top: 10px;
          font-size: 28px;
          line-height: 1.1;
          font-weight: 900;
        }
        .action-summary {
          margin-top: 16px;
          border-radius: 20px;
          padding: 16px 18px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.08);
          font-family: Arial, Helvetica, sans-serif;
          color: #dfebf4;
          line-height: 1.6;
        }
        .ranking-list,
        .loss-list {
          display: grid;
          gap: 12px;
        }
        .ranking-item,
        .loss-item {
          display: grid;
          grid-template-columns: 56px 1fr auto;
          gap: 12px;
          align-items: center;
          border-radius: 18px;
          padding: 14px 16px;
          background: rgba(248, 244, 237, 0.86);
          border: 1px solid rgba(91, 76, 62, 0.1);
          font-family: Arial, Helvetica, sans-serif;
        }
        .ranking-rank {
          font-size: 22px;
          font-weight: 900;
          color: #8b6b54;
        }
        .ranking-name {
          font-size: 18px;
          font-weight: 800;
          color: #162631;
        }
        .ranking-meta,
        .loss-meta {
          margin-top: 4px;
          font-size: 13px;
          color: #667581;
        }
        .ranking-score {
          font-size: 14px;
          font-weight: 800;
          color: #1b2b36;
        }
        .baseline {
          display: grid;
          gap: 12px;
        }
        .baseline-summary {
          border-radius: 18px;
          padding: 16px;
          background: #fffdf9;
          border: 1px solid rgba(91, 76, 62, 0.1);
          font-family: Arial, Helvetica, sans-serif;
          color: #41515d;
          line-height: 1.6;
        }
        .mini-bar {
          display: grid;
          gap: 8px;
        }
        .mini-bar-head {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-family: Arial, Helvetica, sans-serif;
          color: #445561;
          font-size: 14px;
        }
        .mini-bar-track {
          width: 100%;
          height: 10px;
          border-radius: 999px;
          background: rgba(28, 44, 56, 0.1);
          overflow: hidden;
        }
        .mini-bar-fill {
          height: 100%;
          border-radius: 999px;
          background: #9fb3c5;
        }
        .mini-bar-fill.high {
          background: #b53a2b;
        }
        .mini-bar-fill.medium {
          background: #c98e27;
        }
        .mini-bar-fill.low {
          background: #1f8a61;
        }
        .footer-note {
          font-family: Arial, Helvetica, sans-serif;
          color: #6d7a84;
          font-size: 13px;
          line-height: 1.6;
        }
        @media (max-width: 1100px) {
          .layout,
          .status-grid,
          .action-grid {
            grid-template-columns: 1fr;
          }
          .topbar {
            flex-direction: column;
          }
          .meta {
            justify-content: flex-start;
          }
        }
      `}</style>

      <div className="shell">
        <div className="topbar">
          <div>
            <div className="eyebrow">Industrial Decision Panel</div>
            <h1 className="title">ACSM Intelligence Center</h1>
            <p className="subtitle">
              Executive view of system risk, operational diagnosis and recommended action for the
              current industrial state.
            </p>
          </div>
          <div className="meta">
            <span className={`pill ${getRiskTone(riskLevel)}`}>Risk {getRiskLabel(riskLevel)}</span>
            <span className={`pill ${systemState === 'UNSTABLE' ? 'high' : 'low'}`}>
              State {systemState}
            </span>
            <span className="pill">Level 3 {level3Mode}</span>
            <span className="pill">
              Participants {activeParticipantsCount}/{expectedParticipantsCount}
            </span>
          </div>
        </div>

        <div className="layout">
          <div className="column">
            <section className="section">
              <div className="section-header">
                <h2 className="section-title">Global Status</h2>
                <span className="section-note">Plant-wide overview</span>
              </div>
              <div className="status-grid">
                <StatCard
                  label="Global OEE"
                  value={
                    <div className="stat-value-row">
                      <span>{pct(globalOee)}</span>
                      {oeeTrendSignal ? (
                        <span className={`trend-chip ${oeeTrendSignal.tone}`}>
                          {oeeTrendSignal.symbol} {oeeTrendSignal.label}
                        </span>
                      ) : null}
                    </div>
                  }
                  note={
                    baselineLabel
                      ? `Baseline A / P / Q: ${baselineLabel}`
                      : 'Baseline not available'
                  }
                  accent
                />
                <StatCard
                  label="Risk Level"
                  value={getRiskLabel(riskLevel)}
                  note={translatedLearning || 'Operational condition'}
                  tone={getRiskTone(riskLevel)}
                />
                <StatCard
                  label="System State"
                  value={systemState}
                  note={
                    normalizeRisk(riskLevel) === 'high'
                      ? 'Immediate executive attention'
                      : 'State derived from current operating risk'
                  }
                  tone={systemState === 'UNSTABLE' ? 'high' : 'low'}
                />
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="section-note" style={{ marginBottom: 8 }}>
                  OEE trend
                </div>
                <ExecutiveOeeTrendChart data={oeeTrendData} />
              </div>
            </section>

            <section className="section">
              <div className="section-header">
                <h2 className="section-title">Executive Diagnostic</h2>
                <span className="section-note">What requires attention now</span>
              </div>
              <div className="detail-grid">
                <DetailRow
                  label="Primary Issue"
                  value={primaryIssue}
                  tone={getRiskTone(riskLevel)}
                />
                {criticalZone ? (
                  <DetailRow
                    label="Critical Zone"
                    value={criticalZone}
                    tone={getRiskTone(riskLevel)}
                  />
                ) : null}
                {propagationRisk ? (
                  <DetailRow
                    label="Propagation Risk"
                    value={propagationRisk}
                    tone={getRiskTone(propagationRisk.toLowerCase())}
                  />
                ) : null}
              </div>
            </section>

            <section className="section action-center">
              <div className="section-header">
                <h2 className="section-title">Action Center</h2>
                <span className="section-note">Recommended decision</span>
              </div>
              <div className="action-grid">
                <div className="action-card">
                  <div className="action-label">Focus</div>
                  <div className="action-value">{executiveActionPlan.focus}</div>
                </div>
                <div className="action-card">
                  <div className="action-label">Target CPS</div>
                  <div className="action-value">{executiveActionPlan.targetCps}</div>
                </div>
                <div className="action-card">
                  <div className="action-label">Priority</div>
                  <div className="action-value">{executiveActionPlan.priority}</div>
                </div>
                <div className="action-card">
                  <div className="action-label">Expected Impact</div>
                  <div className="action-value" style={{ fontSize: 22 }}>
                    {executiveActionPlan.expectedImpact}
                  </div>
                </div>
              </div>
              <div className="action-summary">
                {safeText(analytics?.recommendation) ||
                  'Coordinate recovery on the critical area and contain further losses.'}
              </div>
            </section>
          </div>

          <div className="column">
            <section className="section">
              <div className="section-header">
                <h2 className="section-title">Impact Summary</h2>
                <span className="section-note">Global top 3 impact view</span>
              </div>

              <div className="ranking-list">
                {topRanking.length
                  ? topRanking.map((item, index) => (
                      <div
                        className="ranking-item"
                        key={`${item?.cpsId || item?.cpsName}-${index}`}
                      >
                        <div className="ranking-rank">#{index + 1}</div>
                        <div>
                          <div className="ranking-name">
                            {safeText(item?.cpsId || item?.cpsName, `CPS ${index + 1}`)}
                          </div>
                          <div className="ranking-meta">
                            {translateLoss(
                              dominantLosses[index]?.dominantDimension ||
                                dominantLosses[index]?.dominantLoss
                            ) || 'Operational Impact'}
                          </div>
                        </div>
                        <div className="ranking-score">Score {safeNum(item?.score, 3)}</div>
                      </div>
                    ))
                  : (
                      <div className="footer-note">
                        No validated impact ranking available for the current runtime.
                      </div>
                    )}
              </div>

              <div style={{ marginTop: 14 }}>
                {rankingChartData.length > 0 ? (
                  <ExecutiveRankingChart data={rankingChartData} />
                ) : (
                  <div className="footer-note">
                    Ranking chart unavailable because no validated CPS impact ranking was received.
                  </div>
                )}
              </div>

              {dominantLossLabel ? <div style={{ height: 14 }} /> : null}

              {dominantLossLabel ? (
                <div className="loss-list">
                  <div className="loss-item">
                    <div className="ranking-rank">01</div>
                    <div>
                      <div className="ranking-name">{dominantLossLabel}</div>
                      <div className="loss-meta">Primary loss across the critical zone</div>
                    </div>
                    <div className="ranking-score">{getRiskLabel(riskLevel)}</div>
                  </div>
                </div>
              ) : null}

              {baselineLabel || apqChartData.length ? <div style={{ height: 14 }} /> : null}

              <div className="baseline">
                <div className="baseline-summary">
                  Current baseline across availability, performance and quality.
                </div>
                <ExecutiveApqChart data={apqChartData} />
                <MiniBar
                  label="Availability"
                  value={availability}
                  tone={
                    availability != null && availability < 0.7
                      ? 'high'
                      : availability != null && availability < 0.85
                        ? 'medium'
                        : 'low'
                  }
                />
                <MiniBar
                  label="Performance"
                  value={performance}
                  tone={
                    performance != null && performance < 0.7
                      ? 'high'
                      : performance != null && performance < 0.85
                        ? 'medium'
                        : 'low'
                  }
                />
                <MiniBar
                  label="Quality"
                  value={quality}
                  tone={
                    quality != null && quality < 0.7
                      ? 'high'
                      : quality != null && quality < 0.85
                        ? 'medium'
                        : 'low'
                  }
                />
              </div>
            </section>

            <section className="section">
              <div className="section-header">
                <h2 className="section-title">Decision Context</h2>
                <span className="section-note">Supporting executive context</span>
              </div>
              <div className="detail-grid">
                <DetailRow label="Executive Context" value={decisionContextSummary} />
                {mostCriticalAcsm ? (
                  <DetailRow label="Primary Focus Area" value={mostCriticalAcsm} />
                ) : null}
                {bottleneckCpsId && bottleneckCpsId !== criticalCpsId ? (
                  <DetailRow label="Constraint Point" value={bottleneckCpsId} />
                ) : null}
                {translatedLearning ? (
                  <DetailRow label="Operational Impact" value={translatedLearning} />
                ) : null}
              </div>
              <div style={{ height: 16 }} />
              <div className="footer-note">
                Current view preserves the full Level 3 data model, but translates it into a
                shorter decision-oriented summary for industrial operators and supervisors.
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
