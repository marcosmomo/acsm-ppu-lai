'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCPSContext } from '../context/CPSContext';
import { normalizeCpsId } from '../lib/acsm/config';
import { buildCpsAnalyticsHref } from '../lib/acsm/analyticsNavigation.mjs';
import {
  getOperationalStateForPresentation,
  getOperationalStatePresentation,
  operationModeBadgeClass,
  operationalStateBadgeClass,
  operationalStateCardClass,
} from '../lib/acsm/cpsStatusPresentation.mjs';
import {
  buildTelemetryRows,
  formatTelemetryValue,
  getCpsLai2PhysicalOperationMode,
  shouldUseLocalTelemetryModal,
} from '../lib/acsm/cpsTelemetry.mjs';
import { deriveCpsLai3PhysicalOperationMode } from '../lib/acsm/cpsLai3OperationMode.mjs';
import { isValidatedPhysicalOperationMode } from '../lib/acsm/cpsOperationMode.mjs';
import {
  CPS_SYNTHETIC_MAX_AGE_MS,
  formatSyntheticPercent,
} from '../lib/acsm/cpsLai3SyntheticIndicators.mjs';
import GovernanceApproval from './GovernanceApproval';

// ===== Status helpers (EN) =====
const normalizeStatus = (status) => String(status || '').toLowerCase();

const DATA_SPACE_URL = 'https://dataspace-v2.vercel.app/';

const PLAY_SERVICE_MAPPING = [
  ['GLOBAL OEE', 'globalOEE.current'],
  ['ACTIVE CPS', 'activeCPS.count / activeCPS.total'],
  ['SYSTEM HEALTH', 'systemHealth.state'],
  ['CRITICAL CPS', 'criticalCPS.cpsId'],
  ['SYSTEM STATE', 'systemState'],
  ['SYSTEM LEARNING', 'learning.state'],
  ['DOMINANT LOSS', 'reasoning.dominantLoss'],
  ['PREDICTED OEE', 'prediction.predictedSystemOEE'],
  ['RECOMMENDATION', 'recommendation.recommendation'],
  ['INTERPRETATION', 'interpretation.summary'],
];

const humanizeFeatStatus = (status) => {
  const s = normalizeStatus(status);
  if (s === 'failure' || s === 'fail' || s === 'error') return 'Failure';
  if (s === 'maintenance') return 'Maintenance';
  if (s === 'awaiting_replacement' || s === 'waiting') return 'Awaiting replacement';
  if (s === 'active' || s === 'ok' || s === 'running') return 'Active';
  return '—';
};

const mapFeatStatusToBadgeClass = (status) => {
  const s = normalizeStatus(status);
  if (s === 'failure' || s === 'fail' || s === 'error') return 'feat-badge feat-failure';
  if (s === 'maintenance') return 'feat-badge feat-maintenance';
  if (s === 'awaiting_replacement' || s === 'waiting') return 'feat-badge feat-waiting';
  if (s === 'active' || s === 'ok' || s === 'running') return 'feat-badge feat-active';
  return 'feat-badge';
};

// ===== Health helpers =====
const humanizeHealthLabel = (label, score) => {
  const l = String(label || '').toLowerCase();

  if (l === 'healthy') return 'Healthy';
  if (l === 'warning') return 'Attention';
  if (l === 'critical') return 'Critical';
  if (l === 'failure') return 'Failure';
  if (l === 'unknown') return 'Unknown';

  const n = Number(score);
  if (!Number.isFinite(n)) return '—';
  if (n >= 80) return 'Healthy';
  if (n >= 50) return 'Attention';
  if (n >= 20) return 'Critical';
  return 'Failure';
};

const mapHealthBadgeClass = (label, score) => {
  const l = String(label || '').toLowerCase();
  const n = Number(score);

  if (l === 'healthy' || (!l && Number.isFinite(n) && n >= 80)) {
    return 'feat-badge feat-active';
  }
  if (l === 'warning' || (!l && Number.isFinite(n) && n >= 50 && n < 80)) {
    return 'feat-badge feat-maintenance';
  }
  if (l === 'critical' || (!l && Number.isFinite(n) && n >= 20 && n < 50)) {
    return 'feat-badge feat-waiting';
  }
  if (l === 'failure' || (!l && Number.isFinite(n) && n < 20)) {
    return 'feat-badge feat-failure';
  }

  return 'feat-badge';
};

// ===== Global CPS State helpers =====
const humanizeGlobalState = (state) => {
  const s = String(state || '').toLowerCase();

  if (s === 'running') return 'Running';
  if (s === 'stopped') return 'Stopped';
  if (s === 'maintenance') return 'Maintenance';
  if (s === 'awaiting_replacement') return 'Awaiting replacement';
  if (s === 'failure') return 'Failure';
  if (s === 'ready') return 'Ready';
  if (s === 'unplugged') return 'Unplugged';
  if (s === 'unknown') return 'UNKNOWN';

  return '—';
};

const humanizeOperationMode = (mode) => {
  const normalized = String(mode || 'UNKNOWN').trim().toUpperCase();
  return ['INIT', 'MANUAL', 'STEP_BY_STEP', 'AUTOMATIC', 'UNKNOWN'].includes(normalized)
    ? normalized
    : 'UNKNOWN';
};

const mapGlobalStateBadgeClass = (state) => {
  const s = String(state || '').toLowerCase();

  if (s === 'running') return 'feat-badge feat-active';
  if (s === 'maintenance') return 'feat-badge feat-maintenance';
  if (s === 'awaiting_replacement') return 'feat-badge feat-waiting';
  if (s === 'failure' || s === 'unplugged') return 'feat-badge feat-failure';
  if (s === 'stopped' || s === 'ready') return 'feat-badge';
  return 'feat-badge';
};

// ===== OEE helpers =====
const formatPercent = (value) => {
  if (value === null || value === undefined || value === '') return '\u2014';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
};

const formatSyntheticRatioForBadge = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value / 100 : null;

const formatProductionCount = (value) => {
  if (value === null || value === undefined || value === '') return '\u2014';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '\u2014';
};

const formatCycleTimeMs = (value) => {
  if (value === null || value === undefined || value === '') return '\u2014';
  const n = Number(value);
  return Number.isFinite(n) ? `${(n / 1000).toFixed(3)} s` : '\u2014';
};

const humanizeOeeLabel = (value) => {
  if (value === null || value === undefined || value === '') return '\u2014';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 0.85) return 'Excellent';
  if (n >= 0.60) return 'Good';
  if (n >= 0.40) return 'Moderate';
  return 'Low';
};

const mapOeeBadgeClass = (value) => {
  if (value === null || value === undefined || value === '') return 'feat-badge';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'feat-badge';
  if (n >= 0.85) return 'feat-badge feat-active';
  if (n >= 0.60) return 'feat-badge feat-maintenance';
  if (n >= 0.40) return 'feat-badge feat-waiting';
  return 'feat-badge feat-failure';
};

const isMeaningfulValue = (value) => {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;
  return !['undefined', 'null', 'nan'].includes(text.toLowerCase());
};

const firstMeaningful = (...values) =>
  values.find((value) => isMeaningfulValue(value));

const formatCompactLabel = (value) => {
  if (!isMeaningfulValue(value)) return '—';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const formatExecutiveText = (value) => {
  if (!isMeaningfulValue(value)) return '—';
  return String(value).trim();
};

const getCriticalCpsLabel = (analytics) => {
  const critical =
    analytics?.criticalCPS && typeof analytics.criticalCPS === 'object'
      ? analytics.criticalCPS
      : null;
  const topRanking =
    Array.isArray(analytics?.criticalityRanking) && analytics.criticalityRanking.length
      ? analytics.criticalityRanking[0]
      : Array.isArray(analytics?.cpsContributionRanking) && analytics.cpsContributionRanking.length
        ? analytics.cpsContributionRanking[0]
        : null;

  return formatExecutiveText(
    firstMeaningful(
      critical?.cpsName,
      critical?.cpsId,
      analytics?.criticalCps,
      analytics?.criticalCPS,
      analytics?.bottleneck?.cpsName,
      analytics?.bottleneck?.cpsId,
      analytics?.bottleneckCps,
      topRanking?.cpsName,
      topRanking?.cpsId
    )
  );
};

const getSystemHealthLabel = (analytics) => {
  const directHealth = firstMeaningful(
    analytics?.systemHealth,
    analytics?.globalHealth,
    analytics?.healthState,
    analytics?.health?.label,
    analytics?.systemState?.health,
    analytics?.systemState?.healthState
  );

  if (directHealth) return formatCompactLabel(directHealth);

  const risk = String(
    firstMeaningful(
      analytics?.riskLevel,
      analytics?.riskSummary?.level,
      analytics?.predictedRisk?.level
    ) || ''
  ).toLowerCase();

  if (risk === 'low') return 'Healthy';
  if (risk === 'medium') return 'Attention';
  if (risk === 'high') return 'Critical';
  if (risk === 'unknown') return 'Unknown';
  return '—';
};

const getSystemStateLabel = (analytics) =>
  formatCompactLabel(
    firstMeaningful(
      analytics?.systemState?.state,
      analytics?.systemState?.status,
      analytics?.systemReasoning?.systemState,
      analytics?.reasoning?.systemState,
      analytics?.globalState,
      analytics?.operationalState
    )
  );

const getSystemLearningLabel = (analytics) =>
  formatCompactLabel(
    firstMeaningful(
      analytics?.learningState,
      analytics?.systemLearningModel?.state,
      analytics?.systemLearningModel?.learningState,
      analytics?.learning?.state,
      analytics?.learning?.learningState,
      analytics?.derivedLearning?.state
    )
  );

const getDominantLossLabel = (analytics) => {
  const firstLoss =
    Array.isArray(analytics?.dominantLosses) && analytics.dominantLosses.length
      ? analytics.dominantLosses[0]
      : null;

  return formatCompactLabel(
    firstMeaningful(
      analytics?.dominantChronicLoss,
      analytics?.dominantLoss,
      analytics?.systemReasoning?.dominantLoss,
      analytics?.reasoning?.dominantLoss,
      firstLoss?.dominantDimension,
      firstLoss?.dominantLoss
    )
  );
};

const getPredictedOeeValue = (analytics) => {
  const forecast = analytics?.systemForecast || {};
  return firstMeaningful(
    analytics?.predictedSystemOEE,
    analytics?.predictedGlobalOEE,
    analytics?.predictedOeeGlobal,
    forecast?.predictedSystemOEE,
    forecast?.predictedGlobalOEE,
    forecast?.expectedOEE,
    forecast?.expectedOee
  );
};

const getRecommendationText = (analytics) =>
  formatExecutiveText(
    firstMeaningful(
      analytics?.recommendation,
      analytics?.systemReasoning?.recommendation,
      analytics?.reasoning?.recommendation,
      analytics?.actionPlan?.recommendation,
      analytics?.coordinatorOutput?.recommendation,
      analytics?.coordinationAction,
      analytics?.adaptiveAction,
      analytics?.directive
    )
  );

const getInterpretationText = (analytics, fallback) =>
  formatExecutiveText(
    firstMeaningful(
      analytics?.reasoning?.executiveInterpretation,
      analytics?.systemReasoning?.executiveInterpretation,
      analytics?.executiveSummary,
      analytics?.explanation,
      fallback
    )
  );

// ===== Generic explanations =====
const statusExplanation = (status) => {
  const s = normalizeStatus(status);

  if (s === 'active' || s === 'ok' || s === 'running') {
    return {
      title: 'Active',
      text:
        'The operation is running normally. The CPS indicates that the routine is executing as expected.',
    };
  }

  if (s === 'maintenance') {
    return {
      title: 'Maintenance',
      text:
        'The operation is in maintenance mode. Execution may be restricted while inspection, calibration, or corrective actions are performed.',
    };
  }

  if (s === 'awaiting_replacement' || s === 'waiting') {
    return {
      title: 'Awaiting replacement',
      text:
        'The operation is paused waiting for a required replacement or intervention before continuing.',
    };
  }

  if (s === 'failure' || s === 'fail' || s === 'error') {
    return {
      title: 'Failure',
      text:
        'A failure condition was detected. The operation cannot continue safely until the cause is resolved.',
    };
  }

  return {
    title: 'Unknown',
    text: 'No recognized status was reported yet. Waiting for the CPS to publish a valid feature state.',
  };
};

const normalizeUrl = (url) => {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `http://${u}`;
};

const getDescriptionUrl = (cps) =>
  normalizeUrl(cps?.endpoints?.description) || normalizeUrl(cps?.dashboardUrl) || '';

const getDataUrl = (cps) =>
  (() => {
    const cpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.baseTopic || cps?.cps);
    if (cpsId === 'cpslai2' || cpsId === 'cpslai3') {
      return `http://localhost:1881/${cpsId}/data`;
    }
    return normalizeUrl(cps?.endpoints?.indicators) ||
      normalizeUrl(cps?.endpoints?.summary) ||
      normalizeUrl(cps?.apiData) ||
      '';
  })();

const getHistoryUrl = (cps) => normalizeUrl(cps?.endpoints?.history) || '';
const getSyntheticIndicatorUrl = (cps, indicator) => {
  const cpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.baseTopic || cps?.cps);
  return cpsId === 'cpslai3' && ['oee', 'health'].includes(indicator)
    ? `http://localhost:1881/cpslai3/synthetic-${indicator}`
    : '';
};
const getHealthUrl = (cps) => getSyntheticIndicatorUrl(cps, 'health') || normalizeUrl(cps?.endpoints?.health) || '';

const getDatasheetUrl = (cps) => {
  const cpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.baseTopic || cps?.cps);
  return cpsId ? `http://127.0.0.1:1881/api/${cpsId}/datasheet/pdf` : '';
};

const openExternalUrl = (url, emptyMessage) => {
  const finalUrl = normalizeUrl(url);
  if (!finalUrl) {
    alert(emptyMessage || 'URL not available for this CPS.');
    return;
  }
  window.open(finalUrl, '_blank', 'noopener,noreferrer');
};

const openSystemAnalyticsPage = (router) => {
  router.push('/analytics-system');
};

const openHcmPage = (router) => {
  router.push('/hcm');
};

const formatDateTime = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '—';
  }
};

const getLifecyclePhase = (cps) =>
  String(
    cps?.lifecyclePhase ??
      cps?.lifecycle?.phase ??
      cps?.lifecycle?.currentPhase ??
      cps?.currentPhase ??
      ''
  )
    .trim()
    .toLowerCase();

const PlayFase = () => {
  const router = useRouter();
  const {
    acsmConfig,
    addedCPS,
    playPhaseCPS,
    startCPSById,
    stopCPSById,
    unplugCPS,
    systemAnalytics,
    stableSystemAnalytics,
    cpsAnalytics,
    getCanonicalOperationalState,
    pendingGovernanceActions,
    decidePendingGovernanceAction,
    telemetryData,
    telemetryCommunication,
  } =
    useCPSContext();

  const [modalOpen, setModalOpen] = useState(false);
  const [modalCpsName, setModalCpsName] = useState('');
  const [modalOperationKey, setModalOperationKey] = useState('');
  const [modalOperationName, setModalOperationName] = useState('');
  const [modalOperationDesc, setModalOperationDesc] = useState('');
  const [modalStatus, setModalStatus] = useState(null);
  const [modalLastUpdate, setModalLastUpdate] = useState(null);
  const [playApiState, setPlayApiState] = useState(null);
  const [playApiModalOpen, setPlayApiModalOpen] = useState(false);
  const [playApiInspection, setPlayApiInspection] = useState({
    state: 'idle',
    data: null,
    httpStatus: null,
    error: null,
  });
  const [playApiCopyFeedback, setPlayApiCopyFeedback] = useState('');
  const [telemetryModalCps, setTelemetryModalCps] = useState(null);
  const [unpluggingCpsId, setUnpluggingCpsId] = useState(null);
  const [unplugError, setUnplugError] = useState('');
  const [unplugSuccess, setUnplugSuccess] = useState('');
  const visibleCPS = Array.isArray(playPhaseCPS) ? playPhaseCPS : addedCPS;
  const registeredCpsCount =
    Array.isArray(acsmConfig?.managedCpsIds) && acsmConfig.managedCpsIds.length > 0
      ? acsmConfig.managedCpsIds.length
      : visibleCPS.length;
  const activeCpsCount = visibleCPS.filter((cps) => getLifecyclePhase(cps) === 'play').length;
  const telemetryModalCpsId = normalizeCpsId(
    telemetryModalCps?.id || telemetryModalCps?.cpsId || telemetryModalCps?.topic
  );
  const telemetryRows = useMemo(
    () => buildTelemetryRows(telemetryData?.[telemetryModalCpsId]),
    [telemetryData, telemetryModalCpsId]
  );
  const telemetryModalEntry = telemetryData?.[telemetryModalCpsId] || null;
  const physicalOperationMode = telemetryModalEntry?.derived || null;
  const physicalOperationModeDisplay = getCpsLai2PhysicalOperationMode(
    telemetryModalEntry,
    telemetryCommunication?.[telemetryModalCpsId] === true
  );

  useEffect(() => {
    const controller = new AbortController();
    const analytics = stableSystemAnalytics || systemAnalytics || {};
    const historySize = Number(analytics?.historySummary?.samples ?? 0);

    fetch('/api/acsm/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        acsmId: acsmConfig?.id || 'acsm1',
        totalCps: registeredCpsCount,
        cps: addedCPS,
        analytics,
        historySize: Number.isFinite(historySize) ? historySize : 0,
      }),
    })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(setPlayApiState)
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[ACSM PLAY] API synchronization failed:', error?.message || error);
      });

    return () => controller.abort();
  }, [acsmConfig?.id, addedCPS, registeredCpsCount, stableSystemAnalytics, systemAnalytics]);

  const globalOee = useMemo(() => {
    const validOees = visibleCPS
      .map((cps) => {
        const cpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.topic);
        const analyticsOee = cpsAnalytics?.[cpsId]?.oee;
        return cps?.oee?.value ?? cps?.oee?.current ?? analyticsOee?.oee ??
          analyticsOee?.value ?? analyticsOee?.current;
      })
      .filter((value) => value !== null && value !== undefined && value !== '')
      .map(Number)
      .filter((v) => Number.isFinite(v) && v >= 0);

    if (!validOees.length) {
      return {
        value: null,
        label: '—',
        badgeClass: 'feat-badge',
        cpsCount: visibleCPS.length,
        measuredCount: 0,
      };
    }

    const avg = validOees.reduce((acc, v) => acc + v, 0) / validOees.length;

    return {
      value: avg,
      label: humanizeOeeLabel(avg),
      badgeClass: mapOeeBadgeClass(avg),
      cpsCount: visibleCPS.length,
      measuredCount: validOees.length,
    };
  }, [cpsAnalytics, visibleCPS]);

  const executiveSummary = useMemo(() => {
    if (activeCpsCount === 0) {
      return {
        systemHealth: '—',
        criticalCps: '—',
        systemState: 'No active CPS',
        systemLearning: '—',
        dominantLoss: '—',
        predictedOee: '—',
        recommendation: 'No active CPS in Play.',
        interpretation: 'No system interpretation available while no CPS is in Play.',
      };
    }

    const analytics = stableSystemAnalytics || systemAnalytics || {};

    return {
      systemHealth: getSystemHealthLabel(analytics),
      criticalCps: getCriticalCpsLabel(analytics),
      systemState: getSystemStateLabel(analytics),
      systemLearning: getSystemLearningLabel(analytics),
      dominantLoss: getDominantLossLabel(analytics),
      predictedOee: formatPercent(getPredictedOeeValue(analytics)),
      recommendation: getRecommendationText(analytics),
      interpretation: getInterpretationText(analytics, globalOee.label),
    };
  }, [activeCpsCount, globalOee.label, stableSystemAnalytics, systemAnalytics]);

  const openStatusDetails = (cps, feat) => {
    setModalCpsName(cps.nome);
    setModalOperationKey(feat?.key || '');
    setModalOperationName(feat?.nome || feat?.key || '');
    setModalOperationDesc(feat?.descricao || '');
    setModalStatus(feat?.statusAtual ?? null);
    setModalLastUpdate(feat?.lastUpdate ?? null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalCpsName('');
    setModalOperationKey('');
    setModalOperationName('');
    setModalOperationDesc('');
    setModalStatus(null);
    setModalLastUpdate(null);
  };

  const openCpsData = (cps, dataUrl) => {
    const cpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.baseTopic || cps?.cps);
    const unavailableMessage = cpsId === 'cpslai3'
      ? 'The CPS-LAI-03 data endpoint could not be opened. Confirm that GET /cpslai3/data is implemented and available in the Node-RED runtime.'
      : 'No data endpoint is available for this CPS.';
    openExternalUrl(dataUrl, unavailableMessage);
  };

  const closeTelemetryModal = () => setTelemetryModalCps(null);

  const loadPlayApiInspection = async () => {
    setPlayApiInspection((current) => ({ ...current, state: 'loading', error: null }));
    setPlayApiCopyFeedback('');

    try {
      const response = await fetch('/api/acsm/play', { method: 'GET', cache: 'no-store' });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), {
          httpStatus: response.status,
        });
      }

      setPlayApiInspection({
        state: 'success',
        data,
        httpStatus: response.status,
        error: null,
      });
    } catch (error) {
      setPlayApiInspection({
        state: 'error',
        data: null,
        httpStatus: error?.httpStatus ?? null,
        error: error?.message || 'Unknown error',
      });
    }
  };

  const openPlayApiModal = () => {
    setPlayApiModalOpen(true);
    loadPlayApiInspection();
  };

  const closePlayApiModal = () => {
    setPlayApiModalOpen(false);
    setPlayApiCopyFeedback('');
  };

  const copyPlayApiJson = async () => {
    if (!playApiInspection.data || !navigator?.clipboard) return;

    try {
      await navigator.clipboard.writeText(JSON.stringify(playApiInspection.data, null, 2));
      setPlayApiCopyFeedback('Copied');
    } catch {
      setPlayApiCopyFeedback('Copy failed');
    }
  };

  const handleExit = async (cps) => {
    setUnplugError('');
    setUnplugSuccess('');
    setUnpluggingCpsId(cps?.id || null);
    try {
      const ok = await unplugCPS(cps?.id || cps?.cpsId);
      if (!ok) throw new Error('ACSM did not complete the Unplug transition.');
      setUnplugSuccess(`${cps?.nome || cps?.id} was unplugged in the ACSM.`);
    } catch (e) {
      setUnplugError(`Unable to unplug ${cps?.nome || cps?.id}: ${e?.message || e}`);
    } finally {
      setUnpluggingCpsId(null);
    }
  };

  return (
    <div className="component-container play-fase">
      <div className="added-cps-display-play">
        <div className="play-phase-summary">
          <h2>Play Phase</h2>
          {unplugError ? <div className="play-api-error" role="alert">{unplugError}</div> : null}
          {unplugSuccess ? <div className="plug-feedback plug-feedback-success" role="status">{unplugSuccess}</div> : null}

          <h3>CPS in Play Phase:</h3>

          <div className="play-executive-summary">
            <div className="play-executive-grid play-executive-grid-primary">
              <div className="play-executive-metric">
                <span className="play-executive-label">GLOBAL OEE</span>
                <strong className="play-executive-value">{formatPercent(playApiState?.globalOEE?.current ?? globalOee.value)}</strong>
              </div>
              <div className="play-executive-metric">
                <span className="play-executive-label">ACTIVE CPS</span>
                <strong className="play-executive-value">
                  {playApiState?.activeCPS?.count ?? activeCpsCount} / {playApiState?.activeCPS?.total ?? registeredCpsCount}
                </strong>
              </div>
              <div className="play-executive-metric">
                <span className="play-executive-label">SYSTEM HEALTH</span>
                <strong className="play-executive-value">{playApiState?.systemHealth?.state ? formatCompactLabel(playApiState.systemHealth.state) : executiveSummary.systemHealth}</strong>
              </div>
              <div className="play-executive-metric">
                <span className="play-executive-label">CRITICAL CPS</span>
                <strong className="play-executive-value">{playApiState ? formatExecutiveText(playApiState.criticalCPS?.cpsId) : executiveSummary.criticalCps}</strong>
              </div>
              <div className="play-executive-metric">
                <span className="play-executive-label">SYSTEM STATE</span>
                <strong className="play-executive-value">{playApiState?.systemState ? formatCompactLabel(playApiState.systemState) : executiveSummary.systemState}</strong>
              </div>
            </div>

            <div className="play-executive-grid play-executive-grid-intelligence">
              <div className="play-executive-metric">
                <span className="play-executive-label">SYSTEM LEARNING</span>
                <strong className="play-executive-value">{playApiState?.learning?.state ? formatCompactLabel(playApiState.learning.state) : executiveSummary.systemLearning}</strong>
              </div>
              <div className="play-executive-metric">
                <span className="play-executive-label">DOMINANT LOSS</span>
                <strong className="play-executive-value">{playApiState ? formatCompactLabel(playApiState.reasoning?.dominantLoss) : executiveSummary.dominantLoss}</strong>
              </div>
              <div className="play-executive-metric">
                <span className="play-executive-label">PREDICTED OEE</span>
                <strong className="play-executive-value">{playApiState ? formatPercent(playApiState.prediction?.predictedSystemOEE) : executiveSummary.predictedOee}</strong>
              </div>
              <div className="play-executive-metric play-executive-metric-wide">
                <span className="play-executive-label">RECOMMENDATION</span>
                <strong className="play-executive-value" title={executiveSummary.recommendation}>
                  {playApiState ? formatExecutiveText(playApiState.recommendation?.recommendation) : executiveSummary.recommendation}
                </strong>
              </div>
            </div>

            <div className="play-executive-footer">
              <div className="play-executive-interpretation">
                <span>Interpretation:</span>
                <strong title={playApiState?.interpretation?.summary || executiveSummary.interpretation}>{playApiState?.interpretation?.summary || executiveSummary.interpretation}</strong>
              </div>

              <div className="play-executive-actions">
                <button
                  onClick={() => openSystemAnalyticsPage(router)}
                  className="play-dashboard-btn"
                  title="Open ACSM system dashboard"
                >
                  ACSM Dashboard
                </button>
                <button
                  onClick={() => openHcmPage(router)}
                  className="play-dashboard-btn"
                  title="Open ACSM Hierarchical Cognitive Memory"
                >
                  HCM
                </button>
                <button
                  onClick={openPlayApiModal}
                  className="play-dashboard-btn"
                  title="Inspect GET /api/acsm/play"
                >
                  Play API
                </button>
              </div>
            </div>
          </div>
        </div>

        <GovernanceApproval
          actions={pendingGovernanceActions}
          onApprove={(actionId) => decidePendingGovernanceAction(actionId, 'approved')}
          onReject={(actionId) => decidePendingGovernanceAction(actionId, 'rejected')}
        />

        <ul className="cps-list-play">
          {visibleCPS.length > 0 ? (
            visibleCPS.map((cps) => {
              const features = Array.isArray(cps.funcionalidades) ? cps.funcionalidades : [];

              const descriptionUrl = getDescriptionUrl(cps);
              const dataUrl = getDataUrl(cps);
              const usesLocalTelemetryModal = shouldUseLocalTelemetryModal(cps);
              const normalizedCpsId = normalizeCpsId(cps?.id || cps?.cpsId || cps?.topic);
              const analyticsHref = buildCpsAnalyticsHref(cps);
              const operationalAnalytics = cpsAnalytics?.[normalizedCpsId] || null;
              const isCpsLai2 = normalizedCpsId === 'cpslai2';
              const isCpsLai3 = normalizedCpsId === 'cpslai3';
              const usesSyntheticIndicators = isCpsLai2 || isCpsLai3;
              const physicalTelemetryConnected =
                telemetryCommunication?.[normalizedCpsId] === true;
              const localPhysicalModeEvidence = usesLocalTelemetryModal
                ? telemetryData?.[normalizedCpsId]
                : null;
              const cpsLai3ModeEvidence = isCpsLai3 ? telemetryData?.[normalizedCpsId] : null;
              const cpsLai3Mode = isCpsLai3
                ? deriveCpsLai3PhysicalOperationMode({
                    cpsId: normalizedCpsId,
                    evidence: cpsLai3ModeEvidence,
                    communication: { dataFresh: physicalTelemetryConnected },
                  })
                : null;
              const operationModeText = usesLocalTelemetryModal
                ? getCpsLai2PhysicalOperationMode(
                    telemetryData?.[normalizedCpsId],
                    physicalTelemetryConnected
                  )
                : isCpsLai3
                  ? cpsLai3Mode?.operationMode || 'INIT'
                  : humanizeOperationMode(cps?.operationalData?.operationMode);
              const historyUrl = getHistoryUrl(cps);
              const oeeUrl = getSyntheticIndicatorUrl(cps, 'oee');
              const healthUrl = getHealthUrl(cps);
              const datasheetUrl = getDatasheetUrl(cps);

              const canonicalOperationalState =
                getCanonicalOperationalState?.(cps) || cps.globalState?.state || cps.status || null;
              const normalizedCpsStatus = String(canonicalOperationalState || '').toLowerCase().trim();

              const isStopped = ['parado', 'stopped', 'stop', 'paused'].includes(normalizedCpsStatus);
              const isRunning = ['rodando', 'running', 'active'].includes(normalizedCpsStatus);

              const globalStateValue = getOperationalStateForPresentation(
                cps,
                canonicalOperationalState,
                usesLocalTelemetryModal
                  ? {
                      operationMode: operationModeText,
                      valid:
                        physicalTelemetryConnected &&
                        isValidatedPhysicalOperationMode(operationModeText) &&
                        localPhysicalModeEvidence?.derived?.operationMode === operationModeText &&
                        localPhysicalModeEvidence?.derived?.semanticValidationStatus === 'PHYSICALLY_VALIDATED',
                    }
                  : isCpsLai3
                    ? {
                        modeEvidence: cpsLai3ModeEvidence,
                        communication: { dataFresh: physicalTelemetryConnected },
                      }
                    : undefined
              );
              const globalStateText = getOperationalStatePresentation(globalStateValue).label;
              const globalStateBadgeCls = operationalStateBadgeClass(globalStateValue);
              const globalStateWhen = formatDateTime(cps.globalState?.lastUpdate);

              const syntheticOeeRecord = usesSyntheticIndicators ? cps.syntheticOee : null;
              const syntheticHealthRecord = usesSyntheticIndicators ? cps.syntheticHealth : null;
              const syntheticOeeFresh = !!syntheticOeeRecord &&
                Date.now() - syntheticOeeRecord.receivedAt <= CPS_SYNTHETIC_MAX_AGE_MS;
              const syntheticHealthFresh = !!syntheticHealthRecord &&
                Date.now() - syntheticHealthRecord.receivedAt <= CPS_SYNTHETIC_MAX_AGE_MS;
              const syntheticOeePayload = syntheticOeeFresh ? syntheticOeeRecord.payload : null;
              const syntheticHealthPayload = syntheticHealthFresh ? syntheticHealthRecord.payload : null;
              const syntheticOeeComputed = syntheticOeePayload?.calculationState === 'SYNTHETIC';
              const syntheticOeeHeld = syntheticOeePayload?.calculationState === 'HELD_LAST_VALUE';
              const syntheticOeeAvailable = syntheticOeeComputed || syntheticOeeHeld;
              const syntheticHealthComputed = syntheticHealthPayload?.calculationState === 'SYNTHETIC';
              const syntheticOeeReason = syntheticOeePayload?.reason ||
                (!syntheticOeeFresh ? 'NO_CURRENT_SYNTHETIC_OEE_SAMPLE' : null);
              const syntheticHealthReason = syntheticHealthPayload?.reason ||
                (!syntheticHealthFresh ? 'NO_CURRENT_SYNTHETIC_HEALTH_SAMPLE' : null);

              const healthUsesSynthetic = usesSyntheticIndicators && syntheticHealthFresh;
              const healthScore = healthUsesSynthetic
                ? syntheticHealthComputed ? syntheticHealthPayload?.health?.current ?? syntheticHealthPayload?.health?.score ?? null : null
                : cps.health?.score ?? null;
              const healthLabel = healthUsesSynthetic
                ? syntheticHealthComputed
                  ? ({ SYNTHETIC_HEALTHY: 'healthy', SYNTHETIC_DEGRADED: 'warning', SYNTHETIC_CRITICAL: 'critical' }[syntheticHealthPayload?.health?.healthState] || null)
                  : null
                : cps.health?.label ?? null;
              const cpsLai2TechnicalHealthLabel =
                normalizedCpsId === 'cpslai2' &&
                cps.health?.healthType === 'CPS_LAI_02_TECHNICAL_HEALTH'
                  ? ({ DEGRADED: 'warning', COMMUNICATION_LOST: 'failure' }[healthLabel] ?? healthLabel)
                  : healthLabel;
              const cpsLai3TechnicalHealthLabel = healthLabel;
              const cpsLai2HealthNotComputed =
                normalizedCpsId === 'cpslai2' &&
                cps.health?.healthType === 'CPS_LAI_02_TECHNICAL_HEALTH' &&
                healthLabel === 'NOT_COMPUTED';
              const syntheticHealthNotComputed = healthUsesSynthetic && !syntheticHealthComputed;
              const cpsLai3HealthNotComputed = isCpsLai3 && !syntheticHealthComputed;
              const healthNotComputed = syntheticHealthNotComputed ||
                (!healthUsesSynthetic && (cpsLai2HealthNotComputed || cpsLai3HealthNotComputed));
              const effectiveHealthLabel = healthUsesSynthetic
                ? cpsLai3TechnicalHealthLabel
                : cpsLai2TechnicalHealthLabel;
              const healthText = cpsLai2HealthNotComputed
                ? 'Unavailable'
                : syntheticHealthNotComputed || cpsLai3HealthNotComputed
                  ? 'Unavailable'
                  : humanizeHealthLabel(effectiveHealthLabel, healthScore);
              const healthBadgeCls = healthNotComputed
                ? 'feat-badge'
                : mapHealthBadgeClass(effectiveHealthLabel, healthScore);
              const healthIndicatorValue = healthUsesSynthetic
                ? formatSyntheticPercent(healthScore)
                : (healthScore ?? '—');
              const healthWhen = formatDateTime(healthUsesSynthetic ? syntheticHealthRecord?.receivedAt : cps.health?.lastUpdate);

              const oeeValue = usesSyntheticIndicators
                ? syntheticOeeAvailable ? syntheticOeePayload?.oee?.current ?? null : null
                : cps.oee?.value ?? cps.oee?.current ?? operationalAnalytics?.oee?.oee ??
                  operationalAnalytics?.oee?.value ?? operationalAnalytics?.oee?.current ?? null;
              const oeeAvailability = usesSyntheticIndicators
                ? syntheticOeeAvailable ? syntheticOeePayload?.oee?.availability ?? null : null
                : cps.oee?.availability ?? operationalAnalytics?.oee?.availability ?? null;
              const oeePerformance = usesSyntheticIndicators
                ? syntheticOeeAvailable ? syntheticOeePayload?.oee?.performance ?? null : null
                : cps.oee?.performance ?? operationalAnalytics?.oee?.performance ?? null;
              const oeeQuality = usesSyntheticIndicators
                ? syntheticOeeAvailable ? syntheticOeePayload?.oee?.quality ?? null : null
                : cps.oee?.quality ?? operationalAnalytics?.oee?.quality ?? null;
              const oeeText = humanizeOeeLabel(usesSyntheticIndicators ? formatSyntheticRatioForBadge(oeeValue) : oeeValue);
              const oeeBadgeCls = mapOeeBadgeClass(usesSyntheticIndicators ? formatSyntheticRatioForBadge(oeeValue) : oeeValue);
              const oeeWhen = formatDateTime(usesSyntheticIndicators
                ? syntheticOeePayload?.calculatedAt || syntheticOeeRecord?.receivedAt
                : cps.oee?.lastUpdate || operationalAnalytics?.timestamp || operationalAnalytics?.ts);
              const oeeTitle = usesSyntheticIndicators
                ? syntheticOeeHeld ? 'Último OEE — cálculo pausado' : 'Experimental OEE'
                : 'Local OEE';
              const isCpsLai1 =
                normalizeCpsId(cps?.id || cps?.cpsId || cps?.topic) === 'cpslai1';
              const production = isCpsLai1
                ? cps?.production || operationalAnalytics?.production || null
                : null;
              const governanceStatus = String(
                cps?.governanceStatus || cps?.governanceProfile?.status || 'NOT_DEFINED'
              );
              const governanceApproved = governanceStatus === 'APPROVED';

              return (
                <li
                  key={cps.id}
                  className={operationalStateCardClass(globalStateValue, cps.id)}
                >
                  <div className="cps-header">
                    <span className="cps-name">
                      {cps.nome} — <strong className="operational-state-value">{globalStateText}</strong></span>

                    <span className={`governance-status governance-status-${governanceStatus.toLowerCase()}`}>
                      {governanceStatus.replace(/_/g, ' ')}
                    </span>

                    <div className="action-buttons">
                      <a
                        href={datasheetUrl || undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="desc-btn"
                        title={
                          datasheetUrl
                            ? `Open datasheet PDF for ${cps.nome}`
                            : 'Datasheet PDF not available'
                        }
                        aria-disabled={!datasheetUrl}
                      >
                        Datasheet PDF
                      </a>

                      {isRunning && (
                        <>
                          <button
                            onClick={() => stopCPSById(cps.id)}
                            className="stop-btn"
                            title="Pause monitoring (CPS keeps running)"
                          >
                            Stop
                          </button>

                          {isCpsLai3 && (
                            <button
                              onClick={() => openExternalUrl(oeeUrl, 'Synthetic OEE endpoint is not available.')}
                              className="desc-btn"
                              title={`Open CPS-LAI-03 synthetic OEE endpoint: ${oeeUrl}`}
                            >
                              OEE API
                            </button>
                          )}

                          <button
                            onClick={() =>
                              openExternalUrl(
                                descriptionUrl,
                                'No DescriptionEndpoint or DashboardURL found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              descriptionUrl
                                ? `Open CPS description: ${descriptionUrl}`
                                : 'Description endpoint not available'
                            }
                            disabled={!descriptionUrl}
                          >
                            Description
                          </button>

                          <button
                            onClick={() => openCpsData(cps, dataUrl)}
                            className="desc-btn"
                            title={
                              dataUrl
                                ? `Open CPS data endpoint in a new tab: ${dataUrl}`
                                : 'Data endpoint not available'
                            }
                            disabled={!usesLocalTelemetryModal && !dataUrl}
                          >
                            Data
                          </button>

                          <button
                            onClick={() =>
                              openExternalUrl(
                                historyUrl,
                                'No HistoryEndpoint found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              historyUrl
                                ? `Open CPS history endpoint: ${historyUrl}`
                                : 'History endpoint not available'
                            }
                            disabled={!historyUrl}
                          >
                            History
                          </button>

                          <button
                            onClick={() =>
                              openExternalUrl(
                                healthUrl,
                                'No HealthEndpoint found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              healthUrl
                                ? `Open CPS health endpoint: ${healthUrl}`
                                : 'Health endpoint not available'
                            }
                            disabled={!healthUrl}
                          >
                            {isCpsLai3 ? 'Synthetic Health API' : 'Health API'}
                          </button>

                          <Link
                            href={analyticsHref}
                            className="desc-btn"
                            title={`Open analytics page for ${cps.nome}`}
                          >
                            Analytics
                          </Link>

                          <button
                            onClick={() =>
                              openExternalUrl(DATA_SPACE_URL, 'Data Space URL not available.')
                            }
                            className="desc-btn"
                            title="Open CPS Data Space"
                          >
                            Data Space
                          </button>
                        </>
                      )}

                      {isStopped && (
                        <>
                          <button
                            onClick={() => startCPSById(cps.id)}
                            className="restart-btn"
                            title={
                              governanceApproved
                                ? 'Resume monitoring'
                                : 'Restart blocked until governance is approved'
                            }
                            disabled={!governanceApproved}
                          >
                            Restart
                          </button>

                          {isCpsLai3 && (
                            <button
                              onClick={() => openExternalUrl(oeeUrl, 'Synthetic OEE endpoint is not available.')}
                              className="desc-btn"
                              title={`Open CPS-LAI-03 synthetic OEE endpoint: ${oeeUrl}`}
                            >
                              OEE API
                            </button>
                          )}

                          <button
                            onClick={() =>
                              openExternalUrl(
                                descriptionUrl,
                                'No DescriptionEndpoint or DashboardURL found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              descriptionUrl
                                ? `Open CPS description: ${descriptionUrl}`
                                : 'Description endpoint not available'
                            }
                            disabled={!descriptionUrl}
                          >
                            Description
                          </button>

                          <button
                            onClick={() => openCpsData(cps, dataUrl)}
                            className="desc-btn"
                            title={
                              dataUrl
                                ? `Open CPS data endpoint in a new tab: ${dataUrl}`
                                : 'Data endpoint not available'
                            }
                            disabled={!usesLocalTelemetryModal && !dataUrl}
                          >
                            Data
                          </button>

                          <button
                            onClick={() =>
                              openExternalUrl(
                                historyUrl,
                                'No HistoryEndpoint found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              historyUrl
                                ? `Open CPS history endpoint: ${historyUrl}`
                                : 'History endpoint not available'
                            }
                            disabled={!historyUrl}
                          >
                            History
                          </button>

                          <button
                            onClick={() =>
                              openExternalUrl(
                                healthUrl,
                                'No HealthEndpoint found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              healthUrl
                                ? `Open CPS health endpoint: ${healthUrl}`
                                : 'Health endpoint not available'
                            }
                            disabled={!healthUrl}
                          >
                            {isCpsLai3 ? 'Synthetic Health API' : 'Health API'}
                          </button>

                          <Link
                            href={analyticsHref}
                            className="desc-btn"
                            title={`Open analytics page for ${cps.nome}`}
                          >
                            Analytics
                          </Link>

                          <button
                            onClick={() =>
                              openExternalUrl(DATA_SPACE_URL, 'Data Space URL not available.')
                            }
                            className="desc-btn"
                            title="Open CPS Data Space"
                          >
                            Data Space
                          </button>

                          <button
                            className="exit-btn"
                            title="Remove CPS from Play Phase"
                            onClick={() => handleExit(cps)}
                            disabled={unpluggingCpsId === cps?.id}
                          >
                            {unpluggingCpsId === cps?.id ? 'Unplugging…' : 'Unplug'}
                          </button>
                        </>
                      )}

                      {!isRunning && !isStopped && (
                        <>
                          <button
                            onClick={() =>
                              openExternalUrl(
                                descriptionUrl,
                                'No DescriptionEndpoint or DashboardURL found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              descriptionUrl
                                ? `Open CPS description: ${descriptionUrl}`
                                : 'Description endpoint not available'
                            }
                            disabled={!descriptionUrl}
                          >
                            Description
                          </button>

                          <button
                            onClick={() => openCpsData(cps, dataUrl)}
                            className="desc-btn"
                            title={
                              dataUrl
                                ? `Open CPS data endpoint in a new tab: ${dataUrl}`
                                : 'Data endpoint not available'
                            }
                            disabled={!usesLocalTelemetryModal && !dataUrl}
                          >
                            Data
                          </button>

                          {isCpsLai3 && (
                            <button
                              onClick={() => openExternalUrl(oeeUrl, 'Synthetic OEE endpoint is not available.')}
                              className="desc-btn"
                              title={`Open CPS-LAI-03 synthetic OEE endpoint: ${oeeUrl}`}
                            >
                              OEE API
                            </button>
                          )}

                          <button
                            onClick={() =>
                              openExternalUrl(
                                historyUrl,
                                'No HistoryEndpoint found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              historyUrl
                                ? `Open CPS history endpoint: ${historyUrl}`
                                : 'History endpoint not available'
                            }
                            disabled={!historyUrl}
                          >
                            History
                          </button>

                          <button
                            onClick={() =>
                              openExternalUrl(
                                healthUrl,
                                'No HealthEndpoint found in the AAS.'
                              )
                            }
                            className="desc-btn"
                            title={
                              healthUrl
                                ? `Open CPS health endpoint: ${healthUrl}`
                                : 'Health endpoint not available'
                            }
                            disabled={!healthUrl}
                          >
                            {isCpsLai3 ? 'Synthetic Health API' : 'Health API'}
                          </button>

                          <Link
                            href={analyticsHref}
                            className="desc-btn"
                            title={`Open analytics page for ${cps.nome}`}
                          >
                            Analytics
                          </Link>

                          <button
                            onClick={() =>
                              openExternalUrl(DATA_SPACE_URL, 'Data Space URL not available.')
                            }
                            className="desc-btn"
                            title="Open CPS Data Space"
                          >
                            Data Space
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="single-feature-card" style={{ marginBottom: 12 }}>
                    <div className="single-feature-row" style={{ marginBottom: 0 }}>
                      <div className="single-feature-title">
                        Operational State: <strong className="operational-state-value">{globalStateText}</strong>
                      </div>

                      <div className="single-feature-status">
                        <span className={globalStateBadgeCls}>{globalStateText}</span>
                      </div>

                      <div className="single-feature-meta">
                        <div className="single-feature-time">
                          Last state update: <span>{globalStateWhen}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {(isCpsLai1 || usesLocalTelemetryModal || isCpsLai3) && (
                    <div className="single-feature-card" style={{ marginBottom: 12 }}>
                      <div className="single-feature-row" style={{ marginBottom: 0 }}>
                        <div className="single-feature-title">
                          Operation Mode: <strong>{operationModeText}</strong>
                        </div>

                        <div className="single-feature-status">
                          <span className={operationModeBadgeClass(operationModeText)}>
                            {operationModeText}
                          </span>
                        </div>

                        <div className="single-feature-meta">
                          <div className="single-feature-time">
                            Last state update: <span>{globalStateWhen}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="single-feature-card" style={{ marginBottom: 12 }}>
                    <div className="single-feature-row" style={{ marginBottom: 0 }}>
                      <div className="single-feature-title">
                        Health Indicator: <strong title={healthUsesSynthetic ? syntheticHealthReason || syntheticHealthPayload?.evidenceStatus : undefined}>{healthIndicatorValue}</strong>
                      </div>

                      <div className="single-feature-status">
                        <span className={healthBadgeCls}>{healthText}</span>
                      </div>

                      <div className="single-feature-meta">
                        {healthUsesSynthetic && <div className="single-feature-time"><span> Synthetic</span></div>}
                        <div className="single-feature-time">
                          Last health update: <span>{healthWhen}</span>
                        </div>
                        {healthUsesSynthetic && !syntheticHealthComputed && (
                          <div className="single-feature-time" title={syntheticHealthPayload?.evidenceStatus || 'No current synthetic Health sample'}>
                            Reason: <span>{syntheticHealthReason}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="single-feature-card" style={{ marginBottom: 12 }}>
                    <div className="single-feature-row" style={{ marginBottom: 8 }}>
                      <div className="single-feature-title">
                        {oeeTitle}: <strong title={usesSyntheticIndicators ? syntheticOeeReason || syntheticOeePayload?.evidenceStatus : undefined}>{usesSyntheticIndicators ? formatSyntheticPercent(oeeValue) : formatPercent(oeeValue)}</strong>
                      </div>

                      <div className="single-feature-status">
                        <span className={oeeBadgeCls}>{oeeText}</span>
                      </div>

                      <div className="single-feature-meta">
                        {usesSyntheticIndicators && <div className="single-feature-time"><span> Synthetic</span></div>}
                        <div className="single-feature-time">
                          Last OEE update: <span>{oeeWhen}</span>
                        </div>
                        {usesSyntheticIndicators && (
                          <div className="single-feature-time">
                            Calculation: <span>{syntheticOeePayload?.calculationState || 'NOT_COMPUTED'}</span>
                            {syntheticOeePayload?.metricSessionId ? <> · Session: <span>{syntheticOeePayload.metricSessionId}</span></> : null}
                          </div>
                        )}
                        {usesSyntheticIndicators && !syntheticOeeComputed && (
                          <div className="single-feature-time" title={syntheticOeePayload?.evidenceStatus || 'No current synthetic OEE sample'}>
                            Reason: <span>{syntheticOeeReason}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="single-feature-row" style={{ marginBottom: 0 }}>
                      <div className="single-feature-title">
                        Availability: <strong>{usesSyntheticIndicators ? formatSyntheticPercent(oeeAvailability) : formatPercent(oeeAvailability)}</strong>
                      </div>

                      <div className="single-feature-title">
                        Performance: <strong>{usesSyntheticIndicators ? formatSyntheticPercent(oeePerformance) : formatPercent(oeePerformance)}</strong>
                      </div>

                      <div className="single-feature-title">
                        Quality: <strong>{usesSyntheticIndicators ? formatSyntheticPercent(oeeQuality) : formatPercent(oeeQuality)}</strong>
                      </div>
                    </div>

                    {isCpsLai1 && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #e2e8f0' }}>
                        <div className="single-feature-title" style={{ marginBottom: 8 }}>
                          <strong>Production Metrics</strong>
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                            gap: 8,
                          }}
                        >
                          <div className="single-feature-title">
                            Total Count:{' '}
                            <strong>{formatProductionCount(production?.totalCount)}</strong>
                          </div>
                          <div className="single-feature-title">
                            Completed Cycles:{' '}
                            <strong>{formatProductionCount(production?.completedCycles)}</strong>
                          </div>
                          <div className="single-feature-title">
                            Incomplete Cycles:{' '}
                            <strong>{formatProductionCount(production?.incompleteCycles)}</strong>
                          </div>
                          <div className="single-feature-title">
                            Last Cycle Time:{' '}
                            <strong>{formatCycleTimeMs(production?.lastCycleTimeMs)}</strong>
                          </div>
                          <div className="single-feature-title">
                            Average Cycle Time:{' '}
                            <strong>{formatCycleTimeMs(production?.averageCycleTimeMs)}</strong>
                          </div>
                        </div>
                      </div>
                    )}

                  </div>

                  <div className="single-feature-card">
                    {features.length > 0 ? (
                      features.map((feat) => {
                        const statusText = globalStateText;
                        const badgeCls = globalStateBadgeCls;
                        const when = globalStateWhen !== '—'
                          ? globalStateWhen
                          : feat?.lastUpdate
                            ? new Date(feat.lastUpdate).toLocaleString()
                            : '—';

                        return (
                          <div
                            key={feat.key}
                            className="single-feature-row operation-feature-row"
                            style={{ marginBottom: 10 }}
                          >
                            <div className="single-feature-title">
                              Operation: <strong className="operational-state-value">{statusText}</strong>
                            </div>

                            <div className="single-feature-status">
                              <span className={badgeCls}>{statusText}</span>
                            </div>

                            <div className="single-feature-meta">
                              <div className="single-feature-time">
                                Last update: <span>{when}</span>
                              </div>
                            </div>

                            <div className="single-feature-actions">
                              <button
                                className="restart-btn"
                                title="Explain what this status means"
                                onClick={() => openStatusDetails(cps, feat)}
                              >
                                Details
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="single-feature-row operation-feature-row" style={{ marginBottom: 10 }}>
                        <div className="single-feature-title">
                          Operation: <strong>{cps?.nome || 'Primary Operation'}</strong>
                        </div>

                        <div className="single-feature-status">
                          <span className={globalStateBadgeCls}>{globalStateText}</span>
                        </div>

                        <div className="single-feature-meta">
                          <div className="single-feature-time">
                            Last update:{' '}
                            <span>{globalStateWhen !== '—' ? globalStateWhen : oeeWhen}</span>
                          </div>
                        </div>

                        <div className="single-feature-actions">
                          <button
                            className="restart-btn"
                            title="Explain current CPS status"
                            onClick={() =>
                              openStatusDetails(cps, {
                                key: 'global_operation',
                                nome: cps?.nome || 'Primary Operation',
                                descricao:
                                  cps?.descricao ||
                                  'Primary CPS operation derived from global state, health, and OEE.',
                                statusAtual: globalStateValue || cps?.status || null,
                                lastUpdate:
                                  cps?.globalState?.lastUpdate ||
                                  cps?.oee?.lastUpdate ||
                                  cps?.health?.lastUpdate ||
                                  null,
                              })
                            }
                          >
                            Details
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })
          ) : (
            <li className="no-cps">No active CPS...</li>
          )}
        </ul>
      </div>

      {telemetryModalCps && (
        <div className="modal-overlay" role="presentation" onClick={closeTelemetryModal}>
          <div
            className="modal telemetry-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="telemetry-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="telemetry-modal-title" className="details-modal-title">
              Physical Telemetry — {telemetryModalCps.nome || telemetryModalCps.displayName || 'CPS-LAI-02'}
            </h3>
            <p className="telemetry-modal-note">
              Real OPC UA samples received through <code>cpslai2/data</code>. The physical mode is
              derived separately from validated markers and never changes Health, OEE, lifecycle
              or PPU state.
            </p>

            <div className="physical-operation-mode" role="status">
              <div>
                <strong>Physical Operation Mode:</strong>{' '}
                <span>{physicalOperationModeDisplay}</span>
              </div>
              <div>
                Source: {physicalOperationMode?.source || 'PHYSICAL_OPCUA_MARKERS'}
              </div>
              <div>
                Semantic status: {physicalOperationMode?.semanticValidationStatus || 'UNAVAILABLE'}
              </div>
              {physicalOperationMode?.reason && (
                <div>Reason: {physicalOperationMode.reason}</div>
              )}
              {physicalOperationMode?.derivedAt && (
                <div>Derived at: {formatDateTime(physicalOperationMode.derivedAt)}</div>
              )}
              <div className="physical-operation-mode-separation">
                Independent from ACSM PPU operational state and lifecycle phase.
              </div>
            </div>

            {telemetryRows.length ? (
              <div className="telemetry-table-wrap">
                <table className="telemetry-table">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Value</th>
                      <th>Quality</th>
                      <th>Datatype</th>
                      <th>NodeId</th>
                      <th>Timestamps</th>
                      <th>Semantic status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {telemetryRows.map((sample) => (
                      <tr key={sample.tag}>
                        <td><code>{sample.tag}</code></td>
                        <td className={sample.valid ? '' : 'telemetry-invalid'}>
                          {formatTelemetryValue(sample)}
                        </td>
                        <td>{sample.quality || sample.statusCode || 'Unknown'}</td>
                        <td>{sample.dataType || '—'}</td>
                        <td><code>{sample.nodeId || '—'}</code></td>
                        <td>
                          <div>Collected: {formatDateTime(sample.collectedAt)}</div>
                          <div>Source: {formatDateTime(sample.sourceTimestamp)}</div>
                          <div>Server: {formatDateTime(sample.serverTimestamp)}</div>
                        </td>
                        <td>
                          <span className="telemetry-semantic-status">
                            {sample.semanticMappingStatus || 'UNSPECIFIED'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="play-api-message" role="status">
                No physical telemetry samples are available for CPS-LAI-02 yet.
              </div>
            )}

            <div className="modal-footer">
              <button className="modal-cancel-btn" onClick={closeTelemetryModal}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay" role="presentation" onClick={closeModal}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="status-details-title"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const info = statusExplanation(modalStatus);
              const when = modalLastUpdate ? new Date(modalLastUpdate).toLocaleString() : '—';

              return (
                <>
                  <h3 id="status-details-title" className="details-modal-title">
                    Status Details — {modalCpsName}
                  </h3>

                  <div className="details-grid">
                    <div>
                      <strong>Operation</strong>
                    </div>
                    <div>{modalOperationName || modalOperationKey || '—'}</div>

                    {modalOperationDesc ? (
                      <>
                        <div>
                          <strong>Description</strong>
                        </div>
                        <div className="details-box">{modalOperationDesc}</div>
                      </>
                    ) : null}

                    <div>
                      <strong>Status</strong>
                    </div>
                    <div>{info.title}</div>

                    <div>
                      <strong>Meaning</strong>
                    </div>
                    <div className="details-box">{info.text}</div>

                    <div>
                      <strong>Last update</strong>
                    </div>
                    <div>{when}</div>
                  </div>

                  <div className="modal-footer">
                    <button className="modal-cancel-btn" onClick={closeModal}>
                      Close
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {playApiModalOpen && (
        <div className="modal-overlay" role="presentation" onClick={closePlayApiModal}>
          <div
            className="modal play-api-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="play-api-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="play-api-modal-title" className="details-modal-title">
              Play Services API
            </h3>

            <div className="play-api-meta">
              <div><strong>Endpoint:</strong> <code>GET /api/acsm/play</code></div>
              <div>
                <strong>Status:</strong>{' '}
                {playApiInspection.httpStatus
                  ? `${playApiInspection.httpStatus}${playApiInspection.httpStatus === 200 ? ' OK' : ''}`
                  : '—'}
              </div>
              <div><strong>Last update:</strong> {playApiInspection.data?.timestamp || '—'}</div>
              <div><strong>Source:</strong> ACSM Play Services</div>
            </div>

            {playApiInspection.state === 'loading' && (
              <div className="play-api-message" role="status">Loading Play API...</div>
            )}

            {playApiInspection.state === 'error' && (
              <div className="play-api-error" role="alert">
                <strong>Unable to load GET /api/acsm/play</strong>
                <span>
                  {playApiInspection.httpStatus ? `HTTP ${playApiInspection.httpStatus}: ` : ''}
                  {playApiInspection.error}
                </span>
              </div>
            )}

            {playApiInspection.state === 'success' && (
              <>
                <section className="play-api-service-mapping" aria-labelledby="play-api-service-mapping-title">
                  <h4 id="play-api-service-mapping-title">Service Mapping</h4>
                  <div className="play-api-mapping-grid">
                    <div className="play-api-mapping-heading">Play Service</div>
                    <div className="play-api-mapping-heading">API Field</div>
                    {PLAY_SERVICE_MAPPING.map(([service, field]) => (
                      <React.Fragment key={service}>
                        <div className="play-api-mapping-service">{service}</div>
                        <code className="play-api-mapping-field">{field}</code>
                      </React.Fragment>
                    ))}
                  </div>
                </section>
                <pre className="play-api-json">{JSON.stringify(playApiInspection.data, null, 2)}</pre>
              </>
            )}

            <div className="modal-footer play-api-modal-footer">
              {playApiCopyFeedback && <span className="play-api-copy-feedback">{playApiCopyFeedback}</span>}
              <button
                className="play-dashboard-btn"
                onClick={loadPlayApiInspection}
                disabled={playApiInspection.state === 'loading'}
              >
                Refresh
              </button>
              <button
                className="play-dashboard-btn"
                onClick={copyPlayApiJson}
                disabled={playApiInspection.state !== 'success' || !playApiInspection.data}
              >
                Copy JSON
              </button>
              <button className="modal-cancel-btn" onClick={closePlayApiModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlayFase;
