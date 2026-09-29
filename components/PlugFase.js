'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCPSContext } from '../context/CPSContext';
import { sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';
import GovernanceConfiguration from './GovernanceConfiguration';

const PLUG_SERVICE_MAPPING = [
  ['REGISTERED CPS', 'summary.registeredCPS'],
  ['OPERATIONALLY LINKED', 'summary.operationallyLinked'],
  ['IDENTIFICATION', 'assets[].identification'],
  ['AAS METADATA', 'assets[].aas'],
  ['DISCOVERED CAPABILITIES', 'assets[].capabilities'],
  ['INTEGRATION INTERFACES', 'assets[].interfaces'],
  ['SUPPORTED PHASES', 'assets[].supportedPhases'],
  ['GOVERNANCE PROFILE', 'assets[].governance'],
  ['LIFECYCLE EVIDENCE', 'assets[].lifecycleEvidence'],
];

const txt = (value, fallback = '-') => sanitizeTextEncoding(value, { fallback });

const formatEventDate = (ts) => {
  if (!ts) return 'Timestamp unavailable';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return 'Invalid date';
  }
};

const getLifecycleBadgeLabel = ({ inPlay, maintenanceInProgress }) => {
  if (maintenanceInProgress) return 'Maintenance';
  if (inPlay) return 'Operational';
  return 'Ready';
};

const getLifecycleBadgeClass = ({ inPlay, maintenanceInProgress }) => {
  if (maintenanceInProgress) return 'plug-asset-state-maintenance';
  if (inPlay) return 'plug-asset-state-operational';
  return 'plug-asset-state-ready';
};

const normalizeCapabilityLabel = (value) =>
  txt(value, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();

const splitCapabilityList = (value) => {
  if (Array.isArray(value)) return value.map(normalizeCapabilityLabel).filter(Boolean);
  return String(value || '')
    .split(/[|,;/]+/)
    .map(normalizeCapabilityLabel)
    .filter(Boolean);
};

const hasAasSubmodel = (cps, pattern) => {
  const normalizedPattern = String(pattern || '').toLowerCase();
  const aasMetadata = cps?.aasMetadata || cps?.details?.aasMetadata || {};
  const discoveredAasValues = [
    aasMetadata.id,
    aasMetadata.idShort,
    ...(Array.isArray(aasMetadata.submodelRefs) ? aasMetadata.submodelRefs : []),
    ...(Array.isArray(aasMetadata.submodelIdShorts) ? aasMetadata.submodelIdShorts : []),
    ...(Array.isArray(aasMetadata.elementIdShorts) ? aasMetadata.elementIdShorts : []),
    ...(cps?.aas?.submodels || []).flatMap((ref) => [
      ref?.value,
      ...(Array.isArray(ref?.keys) ? ref.keys.map((key) => key?.value) : []),
    ]),
    ...(cps?.aas?.submodelElements || []).map((el) => el?.idShort),
  ];

  return discoveredAasValues.some((value) =>
    String(value || '').toLowerCase().includes(normalizedPattern)
  );
};

const hasAasEvidence = (cps) => {
  const aasMetadata = cps?.aasMetadata || cps?.details?.aasMetadata || {};
  return Boolean(
    cps?.aas ||
      aasMetadata.id ||
      aasMetadata.idShort ||
      (Array.isArray(aasMetadata.submodelRefs) && aasMetadata.submodelRefs.length) ||
      (Array.isArray(aasMetadata.submodelIdShorts) && aasMetadata.submodelIdShorts.length)
  );
};

const inferProcessCapabilities = (cps) => {
  const source = `${cps?.assetType || ''} ${(cps?.funcionalidades || [])
    .map((item) => `${item?.nome || ''} ${item?.key || ''} ${item?.descricao || ''}`)
    .join(' ')}`.toLowerCase();

  if (source.includes('weld') || source.includes('sold')) return ['Welding'];
  if (source.includes('vision') || source.includes('inspection') || source.includes('visao')) return ['Visual Inspection'];
  if (source.includes('conveyor') || source.includes('transport')) return ['Transportation'];
  return cps?.assetType ? [normalizeCapabilityLabel(cps.assetType)] : [];
};

const buildDiscoveredCapabilities = (cps) => {
  const endpoints = cps?.endpoints || {};
  const supportedPhases = splitCapabilityList(cps?.lifecycle?.supportedPhases);
  const lifecycleServices = new Set(supportedPhases);

  const monitoring = new Set();
  if (endpoints.summary || endpoints.indicators || cps?.operationalData) monitoring.add('Telemetry');
  if (endpoints.health || cps?.health || hasAasSubmodel(cps, 'statusandhealth')) monitoring.add('Health');
  if (cps?.oee || hasAasSubmodel(cps, 'oee')) monitoring.add('OEE');

  const cognitive = new Set();
  if (
    hasAasSubmodel(cps, 'learning') ||
    hasAasSubmodel(cps, 'reasoning') ||
    hasAasSubmodel(cps, 'recommendation') ||
    hasAasSubmodel(cps, 'acsm')
  ) {
    cognitive.add('Learning');
    cognitive.add('Reasoning');
    cognitive.add('Recommendation');
  }

  const integration = new Set();
  if (cps?.topic || cps?.brokerWs || cps?.brokerWss) integration.add('MQTT');
  if (Object.values(endpoints).some(Boolean)) integration.add('REST');
  if (hasAasEvidence(cps)) integration.add('AAS');

  return [
    { group: 'Process', items: inferProcessCapabilities(cps) },
    { group: 'Lifecycle Services', items: Array.from(lifecycleServices) },
    { group: 'Monitoring', items: Array.from(monitoring) },
    { group: 'Cognitive', items: Array.from(cognitive) },
    { group: 'Integration', items: Array.from(integration) },
  ].filter((section) => section.items.length);
};

const normalizeCpsKey = (value) =>
  String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1');

const getEvidenceForCps = (events = [], cps) => {
  const cpsKeys = new Set(
    [cps?.id, cps?.nome, cps?.topic, cps?.lifecycle?.cpsId, cps?.lifecycle?.baseTopic]
      .map(normalizeCpsKey)
      .filter(Boolean)
  );

  const cpsEvents = events.filter((event) =>
    [event?.cpsId, event?.cpsName, event?.topic, event?.details?.cpsId, event?.details?.lifecycleBaseTopic]
      .map(normalizeCpsKey)
      .some((key) => cpsKeys.has(key))
  );

  const maintenanceEvents = cpsEvents.filter((event) => {
    const type = String(event?.eventType || event?.type || '').toLowerCase();
    return type === 'maintenance_entered' || type === 'maintenance_started';
  });
  const evolutionEvents = cpsEvents
    .filter((event) => String(event?.eventType || event?.type || '').toLowerCase() === 'evolution')
    .sort((a, b) => Number(b?.ts || Date.parse(b?.isoDate || '')) - Number(a?.ts || Date.parse(a?.isoDate || '')));

  return {
    maintenanceCount: maintenanceEvents.length,
    lastEvolution: evolutionEvents[0] || null,
    lastEvolutionTimestamp: evolutionEvents[0]?.ts || evolutionEvents[0]?.isoDate || null,
    events: cpsEvents,
  };
};

export default function PlugFase() {
  const {
    acsmConfig,
    availableCPSNames = [],
    availableCPS = [],
    registerCPS,
    addCPS,
    addedCPS,
    playPhaseCPS,
    unplugCPS,
    refreshGovernanceProfile,
    updateGovernanceProfile,
    approveGovernanceProfile,
    rejectGovernanceProfile,
  } =
    useCPSContext();

  const fileInputRef = useRef(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isDownloadingLog, setIsDownloadingLog] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [selectedGovernanceCpsId, setSelectedGovernanceCpsId] = useState(null);
  const [governancePanelLoading, setGovernancePanelLoading] = useState(false);
  const [governancePanelError, setGovernancePanelError] = useState('');
  const [plugLifecycleEvents, setPlugLifecycleEvents] = useState([]);
  const [plugApiModalOpen, setPlugApiModalOpen] = useState(false);
  const [plugApiInspection, setPlugApiInspection] = useState({
    state: 'idle', data: null, httpStatus: null, error: null,
  });
  const [plugApiCopyFeedback, setPlugApiCopyFeedback] = useState('');

  const eligiblePlayCPS = Array.isArray(playPhaseCPS) ? playPhaseCPS : addedCPS;
  const cpsNamesInPlay = useMemo(
    () => new Set((eligiblePlayCPS || []).map((cps) => cps.nome)),
    [eligiblePlayCPS]
  );
  const cpsByName = useMemo(() => {
    const map = {};
    (availableCPS || []).forEach((cps) => {
      if (cps?.nome) map[cps.nome] = cps;
    });
    return map;
  }, [availableCPS]);
  const selectedGovernanceCps = useMemo(
    () =>
      selectedGovernanceCpsId
        ? (availableCPS || []).find((cps) => cps?.id === selectedGovernanceCpsId) || null
        : null,
    [availableCPS, selectedGovernanceCpsId]
  );

  const plugApiAssets = useMemo(
    () => (availableCPS || []).map((cps) => {
      const lifecycleEvidence = getEvidenceForCps(plugLifecycleEvents, cps);
      const profile = cps?.governanceProfile || {};

      return {
        cps: {
          cpsId: cps?.id || null,
          displayName: cps?.displayName || cps?.nome || null,
          lifecyclePhase: cps?.lifecyclePhase || cps?.lifecycle?.currentPhase || null,
          status: cps?.status || null,
          operationalState: cps?.operationalState || null,
        },
        identification: {
          manufacturer: cps?.manufacturer || null,
          assetType: cps?.assetType || null,
          serialNumber: cps?.serialNumber || null,
          description: cps?.descricao || null,
        },
        aas: cps?.aasMetadata || null,
        capabilities: buildDiscoveredCapabilities(cps),
        interfaces: {
          baseTopic: cps?.topic || null,
          brokerHost: cps?.server || null,
          brokerPort: cps?.brokerPort || null,
          brokerWebSocket: cps?.brokerWs || null,
          endpoints: cps?.endpoints || null,
        },
        supportedPhases: splitCapabilityList(cps?.lifecycle?.supportedPhases),
        governance: {
          profileId: profile?.profileId || null,
          profileVersion: profile?.profileVersion ?? null,
          status: cps?.governanceStatus || profile?.status || 'NOT_AVAILABLE',
        },
        lifecycleEvidence: {
          maintenanceCount: lifecycleEvidence.maintenanceCount,
          lastEvolutionTimestamp: lifecycleEvidence.lastEvolutionTimestamp,
          events: lifecycleEvidence.events,
        },
      };
    }),
    [availableCPS, plugLifecycleEvents]
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/acsm/plug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        acsmId: acsmConfig?.id || 'acsm1',
        timestamp: new Date().toISOString(),
        operationallyLinked: eligiblePlayCPS.length,
        assets: plugApiAssets,
      }),
    }).catch((error) => {
      if (error?.name !== 'AbortError') console.warn('[ACSM PLUG] API synchronization failed:', error?.message || error);
    });
    return () => controller.abort();
  }, [acsmConfig?.id, eligiblePlayCPS.length, plugApiAssets]);

  const loadPlugApiInspection = async () => {
    setPlugApiInspection((current) => ({ ...current, state: 'loading', error: null }));
    setPlugApiCopyFeedback('');
    try {
      const response = await fetch('/api/acsm/plug', { method: 'GET', cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { httpStatus: response.status });
      }
      setPlugApiInspection({ state: 'success', data, httpStatus: response.status, error: null });
    } catch (error) {
      setPlugApiInspection({
        state: 'error', data: null, httpStatus: error?.httpStatus ?? null,
        error: error?.message || 'Unknown error',
      });
    }
  };

  const openPlugApiModal = () => {
    setPlugApiModalOpen(true);
    loadPlugApiInspection();
  };

  const closePlugApiModal = () => {
    setPlugApiModalOpen(false);
    setPlugApiCopyFeedback('');
  };

  const copyPlugApiJson = async () => {
    if (!plugApiInspection.data || !navigator?.clipboard) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(plugApiInspection.data, null, 2));
      setPlugApiCopyFeedback('Copied');
    } catch {
      setPlugApiCopyFeedback('Copy failed');
    }
  };

  const loadLifecycleEvents = useCallback(async () => {
    try {
      const response = await fetch('/api/plug-log', { method: 'GET', cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        setPlugLifecycleEvents(Array.isArray(data?.events) ? data.events : []);
      }
    } catch {
      setPlugLifecycleEvents([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timerId = null;

    const refreshLifecycleEvents = () => {
      if (!cancelled) loadLifecycleEvents();
    };

    refreshLifecycleEvents();
    window.addEventListener('plug-lifecycle-evidence-updated', refreshLifecycleEvents);
    timerId = window.setInterval(refreshLifecycleEvents, 30000);

    return () => {
      cancelled = true;
      window.removeEventListener('plug-lifecycle-evidence-updated', refreshLifecycleEvents);
      if (timerId) window.clearInterval(timerId);
    };
  }, [loadLifecycleEvents]);

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatusMsg('');
    setErrorMsg('');

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(String(evt.target?.result || ''));
        const ok = registerCPS(parsed);
        if (ok) setStatusMsg('CPS loaded into Plug Phase successfully.');
        else setErrorMsg('Failed to load CPS into Plug Phase. Check the lifecycle log.');
      } catch {
        setErrorMsg('Invalid JSON or incompatible CPS AAS. Verify assetAdministrationShells, submodels and AssetInterfacesDescription.');
      } finally {
        e.target.value = '';
      }
    };
    reader.onerror = () => {
      setErrorMsg('Could not read the selected file.');
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  const downloadFile = async (endpoint, fallbackName, successMessage, errorBase, setLoading) => {
    try {
      setLoading(true);
      setStatusMsg('');
      setErrorMsg('');

      const response = await fetch(endpoint, { method: 'GET', cache: 'no-store' });
      if (!response.ok) {
        let message = errorBase;
        try {
          const err = await response.json();
          message = err?.error || err?.details || message;
        } catch {
          // ignore
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      let fileName = fallbackName;
      if (disposition) {
        const match = disposition.match(/filename="([^"]+)"/);
        if (match?.[1]) fileName = match[1];
      }

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setStatusMsg(successMessage);
    } catch (error) {
      console.error(errorBase, error);
      setErrorMsg(error.message || errorBase);
    } finally {
      setLoading(false);
    }
  };

  const handleReviewGovernance = async (cps) => {
    if (!cps?.id) return;

    setSelectedGovernanceCpsId(cps.id);
    setGovernancePanelError('');
    setGovernancePanelLoading(true);

    try {
      const profile = await refreshGovernanceProfile?.(cps.id);
      if (!profile) setGovernancePanelError('Unable to load Governance Profile.');
    } catch {
      setGovernancePanelError('Unable to load Governance Profile.');
    } finally {
      setGovernancePanelLoading(false);
    }
  };

  const handleApproveGovernance = async (cpsId) => {
    if (!cpsId) return;

    setGovernancePanelError('');
    setGovernancePanelLoading(true);
    try {
      const ok = await approveGovernanceProfile?.(cpsId);
      if (!ok) {
        setGovernancePanelError('Unable to approve Governance Profile.');
        return;
      }
      await refreshGovernanceProfile?.(cpsId);
    } catch {
      setGovernancePanelError('Unable to approve Governance Profile.');
    } finally {
      setGovernancePanelLoading(false);
    }
  };

  const handleRejectGovernance = async (cpsId) => {
    if (!cpsId) return;

    setGovernancePanelError('');
    setGovernancePanelLoading(true);
    try {
      const ok = await rejectGovernanceProfile?.(cpsId);
      if (!ok) {
        setGovernancePanelError('Unable to reject Governance Profile.');
        return;
      }
      await refreshGovernanceProfile?.(cpsId);
    } catch {
      setGovernancePanelError('Unable to reject Governance Profile.');
    } finally {
      setGovernancePanelLoading(false);
    }
  };

  return (
    <div className="component-container plug-fase plug-asset-phase">
      <div className="plug-phase-summary">
        <div className="plug-asset-header plug-asset-header-top">
          <div className="plug-asset-header-main">
            <h2>Plug Phase</h2>
            <p className="plug-asset-subtitle">
              Asset registration, onboarding and lifecycle evidence for cyber-physical systems.
            </p>
          </div>

          <div className="plug-asset-summary plug-asset-summary-extended">
            <div className="plug-asset-summary-card">
              <span className="plug-asset-summary-label">Registered CPS</span>
              <strong className="plug-asset-summary-value">{availableCPSNames.length}</strong>
            </div>
            <div className="plug-asset-summary-card">
              <span className="plug-asset-summary-label">Operationally linked</span>
              <strong className="plug-asset-summary-value">{eligiblePlayCPS.length}</strong>
            </div>
            <button
              type="button"
              className={`plug-asset-summary-card plug-asset-summary-card-action ${isDownloadingLog ? 'is-loading' : ''}`}
              onClick={() =>
                downloadFile(
                  '/api/plug-log/export',
                  'plug-phase-log.json',
                  'Plug Phase JSON lifecycle log downloaded successfully.',
                  'Failed to download the lifecycle JSON log.',
                  setIsDownloadingLog
                )
              }
              disabled={isDownloadingLog}
            >
              <span className="plug-asset-summary-label">Lifecycle log</span>
              <strong className="plug-asset-summary-action-value">
                {isDownloadingLog ? 'Exporting...' : 'Export JSON'}
              </strong>
            </button>
            <button
              type="button"
              className={`plug-asset-summary-card plug-asset-summary-card-action ${isDownloadingPdf ? 'is-loading' : ''}`}
              onClick={() =>
                downloadFile(
                  '/api/plug-log/export-pdf',
                  'plug-phase-log-report.pdf',
                  'Plug Phase PDF lifecycle report downloaded successfully.',
                  'Failed to download the lifecycle PDF report.',
                  setIsDownloadingPdf
                )
              }
              disabled={isDownloadingPdf}
            >
              <span className="plug-asset-summary-label">Lifecycle report</span>
              <strong className="plug-asset-summary-action-value">
                {isDownloadingPdf ? 'Exporting...' : 'Export PDF'}
              </strong>
            </button>
          </div>
        </div>

        <div className="button-group plug-asset-actions">
          <button type="button" onClick={handlePickFile}>Load AAS manually...</button>
          <button
            type="button"
            className="play-dashboard-btn"
            onClick={openPlugApiModal}
            title="Inspect GET /api/acsm/plug"
          >
            Plug API
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-label="Select CPS JSON file"
          />
        </div>

        {statusMsg ? <div className="plug-feedback plug-feedback-success" role="status">{statusMsg}</div> : null}
        {errorMsg ? <div className="plug-feedback plug-feedback-error" role="alert">{errorMsg}</div> : null}
      </div>

      <div className="plug-phase-scroll-content plug-asset-section">
        <div className="plug-asset-section-header">
          <h3>Lifecycle registry</h3>
          <span className="plug-asset-section-caption">Registered industrial assets and lifecycle evidence</span>
        </div>

        {availableCPSNames.length ? (
          <div className="plug-asset-grid">
            {availableCPSNames.map((name) => {
              const inPlay = cpsNamesInPlay.has(name);
              const cps = cpsByName[name] || null;
              const maintenanceInProgress = !!cps?.maintenance?.inProgress;

              const governanceStatus = txt(cps?.governanceStatus || cps?.governanceProfile?.status, 'NOT_DEFINED');
              const capabilities = buildDiscoveredCapabilities(cps);
              const lifecycleEvidence = getEvidenceForCps(plugLifecycleEvents, cps);

              return (
                <article key={name} className="plug-asset-card">
                  <div className="plug-asset-card-topbar">
                    <div className="plug-asset-card-titleblock">
                      <div className="plug-asset-card-title-row">
                        <h4 className="plug-asset-card-title">{txt(name)}</h4>
                        <span className={`plug-asset-state-badge ${getLifecycleBadgeClass({ inPlay, maintenanceInProgress })}`}>
                          {getLifecycleBadgeLabel({ inPlay, maintenanceInProgress })}
                        </span>
                      </div>

                      <div className="plug-asset-card-subline">
                        {cps?.id ? <span>CPS ID: {txt(cps.id)}</span> : null}
                        {cps?.topic ? <span>MQTT Topic: {txt(cps.topic)}</span> : null}
                        {cps?.server ? <span>Broker: {txt(cps.server)}</span> : null}
                      </div>
                    </div>

                    <div className="plug-asset-card-actions">
                      {inPlay ? (
                        <button className="exit-btn" onClick={() => unplugCPS(name)}>Unplug</button>
                      ) : (
                        <button
                          className="start-ops-btn"
                          onClick={() => {
                            const ok = addCPS(name);
                            if (!ok) setErrorMsg('PLAY_NOT_ALLOWED: GOVERNANCE_NOT_APPROVED');
                          }}
                          disabled={governanceStatus !== 'APPROVED'}
                          title={
                            governanceStatus === 'APPROVED'
                              ? 'Start Play Phase'
                              : 'Play blocked until governance is approved'
                          }
                        >
                          Play
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="plug-asset-card-body">
                    <div className="plug-asset-overview-row">
                      <div className="plug-asset-description-box">
                        <div className="plug-asset-box-title">Asset description</div>
                        <p className="plug-asset-description">
                          {txt(cps?.descricao, 'No description available for this CPS.')}
                        </p>
                      </div>

                      <GovernanceConfiguration
                        cps={cps}
                        onRefresh={refreshGovernanceProfile}
                        onReview={handleReviewGovernance}
                        isOpen={false}
                      />
                    </div>

                    <section className="plug-asset-capabilities">
                      <div className="plug-asset-box-title">Discovered Capabilities</div>
                      <div className="plug-asset-capability-groups">
                        {capabilities.map((section) => (
                          <div key={section.group} className="plug-asset-capability-group">
                            <span className="plug-asset-capability-group-title">{section.group}</span>
                            <div className="plug-asset-capability-chips">
                              {section.items.map((item) => (
                                <span key={`${section.group}-${item}`} className="plug-asset-capability-chip">
                                  {item}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="plug-asset-lifecycle-evidence">
                      <div className="plug-asset-box-title">Lifecycle Evidence</div>
                      <div className="plug-asset-condition-grid plug-asset-evidence-grid">
                      <div className="plug-asset-info-box">
                        <span className="plug-asset-info-label">Recorded Maintenance Events</span>
                        <strong className="plug-asset-info-value">{lifecycleEvidence.maintenanceCount}</strong>
                      </div>
                      <div className="plug-asset-info-box">
                        <span className="plug-asset-info-label">Last Recorded Update</span>
                        <strong className="plug-asset-info-value">
                          {lifecycleEvidence.lastEvolution
                            ? formatEventDate(lifecycleEvidence.lastEvolution.ts || lifecycleEvidence.lastEvolution.isoDate)
                            : '-'}
                        </strong>
                      </div>
                      </div>
                    </section>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="plug-empty-state">No CPS currently registered in Plug Phase.</div>
        )}
      </div>

      {selectedGovernanceCps ? (
        <div className="modal-overlay" role="presentation" onClick={() => setSelectedGovernanceCpsId(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Governance Configuration"
            onClick={(event) => event.stopPropagation()}
          >
            <GovernanceConfiguration
              cps={selectedGovernanceCps}
              onRefresh={refreshGovernanceProfile}
              onSave={updateGovernanceProfile}
              onApprove={handleApproveGovernance}
              onReject={handleRejectGovernance}
              onReview={handleReviewGovernance}
              onClose={() => setSelectedGovernanceCpsId(null)}
              isOpen
              isLoading={governancePanelLoading}
              errorMessage={governancePanelError}
            />
          </div>
        </div>
      ) : null}

      {plugApiModalOpen ? (
        <div className="modal-overlay" role="presentation" onClick={closePlugApiModal}>
          <div
            className="modal play-api-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plug-api-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="plug-api-modal-title" className="details-modal-title">Plug Services API</h3>
            <div className="play-api-meta">
              <div><strong>Endpoint:</strong> <code>GET /api/acsm/plug</code></div>
              <div>
                <strong>Status:</strong>{' '}
                {plugApiInspection.httpStatus
                  ? `${plugApiInspection.httpStatus}${plugApiInspection.httpStatus === 200 ? ' OK' : ''}`
                  : '—'}
              </div>
              <div><strong>Last update:</strong> {plugApiInspection.data?.timestamp || '—'}</div>
              <div><strong>Source:</strong> ACSM Plug Services</div>
            </div>

            {plugApiInspection.state === 'loading' ? (
              <div className="play-api-message" role="status">Loading Plug API...</div>
            ) : null}
            {plugApiInspection.state === 'error' ? (
              <div className="play-api-error" role="alert">
                <strong>Unable to load GET /api/acsm/plug</strong>
                <span>
                  {plugApiInspection.httpStatus ? `HTTP ${plugApiInspection.httpStatus}: ` : ''}
                  {plugApiInspection.error}
                </span>
              </div>
            ) : null}
            {plugApiInspection.state === 'success' ? (
              <>
                <section className="play-api-service-mapping" aria-labelledby="plug-api-mapping-title">
                  <h4 id="plug-api-mapping-title">Service Mapping</h4>
                  <div className="play-api-mapping-grid">
                    <div className="play-api-mapping-heading">Phase Service</div>
                    <div className="play-api-mapping-heading">API Field</div>
                    {PLUG_SERVICE_MAPPING.map(([service, field]) => (
                      <React.Fragment key={service}>
                        <div className="play-api-mapping-service">{service}</div>
                        <code className="play-api-mapping-field">{field}</code>
                      </React.Fragment>
                    ))}
                  </div>
                </section>
                <pre className="play-api-json">{JSON.stringify(plugApiInspection.data, null, 2)}</pre>
              </>
            ) : null}

            <div className="modal-footer play-api-modal-footer">
              {plugApiCopyFeedback ? <span className="play-api-copy-feedback">{plugApiCopyFeedback}</span> : null}
              <button
                className="play-dashboard-btn"
                onClick={loadPlugApiInspection}
                disabled={plugApiInspection.state === 'loading'}
              >
                Refresh
              </button>
              <button
                className="play-dashboard-btn"
                onClick={copyPlugApiJson}
                disabled={plugApiInspection.state !== 'success' || !plugApiInspection.data}
              >
                Copy JSON
              </button>
              <button className="modal-cancel-btn" onClick={closePlugApiModal}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
