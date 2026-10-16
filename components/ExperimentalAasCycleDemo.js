'use client';

import React, { useRef, useState } from 'react';
import threeStateEvolution from '../docs/experiments/cpslai1-three-state-evolution.json' with { type: 'json' };
import AasFunctionalCapabilitiesPreview from './AasFunctionalCapabilitiesPreview';

const evolutionSteps = threeStateEvolution.steps;

export default function ExperimentalAasCycleDemo({ cpsId }) {
  const [view, setView] = useState('document');
  const [sequenceStep, setSequenceStep] = useState(-1);
  const [editableRefresh, setEditableRefresh] = useState(null);
  const [refreshState, setRefreshState] = useState({ loading: false, error: null });
  const experimentalSessionId = useRef(null);
  const refreshRequestId = useRef(0);
  const selectedStep = sequenceStep >= 0 ? evolutionSteps[sequenceStep] : null;

  const selectEvolutionStep = (index) => {
    if (index === sequenceStep) {
      setView('sequence');
      return;
    }
    if (index !== sequenceStep + 1) return;
    setSequenceStep(index);
    setView('sequence');
  };

  const refreshEditableAas = async () => {
    const requestId = ++refreshRequestId.current;
    setRefreshState({ loading: true, error: null });
    try {
      experimentalSessionId.current ||= globalThis.crypto?.randomUUID?.() ||
        `experimental-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const headers = { 'x-experimental-aas-session': experimentalSessionId.current };
      const response = await fetch(`/api/experiments/aas/cpslai1?refresh=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        headers,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
      if (!result?.projection?.contentHash || !Array.isArray(result.projection.capabilities) || !result.snapshot) {
        throw new Error('Experimental AAS refresh returned an invalid projection.');
      }
      if (requestId !== refreshRequestId.current) return;
      setEditableRefresh({
        projection: result.projection,
        evolution: result.evolution,
        snapshot: result.snapshot,
        diagnostics: result.diagnostics || null,
      });
      setView('refresh');
      setRefreshState({ loading: false, error: null });
    } catch (error) {
      if (requestId !== refreshRequestId.current) return;
      setRefreshState({ loading: false, error: error?.message || 'Experimental AAS refresh failed.' });
    }
  };

  return (
    <section className="aas-experimental-demo" aria-labelledby="aas-experimental-demo-title">
      <div className="aas-experimental-demo-header">
        <div>
          <span>SUPERVISED READ-ONLY DEMONSTRATION</span>
          <h5 id="aas-experimental-demo-title">Experimental AAS / PPU / Evolution projection</h5>
          <p>Sequential verified AAS documents. These controls do not execute Plug, Play, Approve or Unplug.</p>
        </div>
        <strong>NO OPERATIONAL EFFECT</strong>
      </div>

      <div className="aas-experimental-demo-controls" role="group" aria-label="Experimental AAS evolution sequence">
        <button type="button" onClick={refreshEditableAas} disabled={refreshState.loading}>
          {refreshState.loading ? 'Refreshing AAS…' : 'Refresh AAS'}
        </button>
        <button type="button" className={view === 'document' ? 'is-active' : ''} onClick={() => setView('document')}>
          Document preview
        </button>
        {evolutionSteps.map((step, index) => (
          <button
            type="button"
            key={step.id}
            className={view === 'sequence' && sequenceStep === index ? 'is-active' : ''}
            disabled={index < sequenceStep || index > sequenceStep + 1}
            onClick={() => selectEvolutionStep(index)}
          >
            {step.label}
          </button>
        ))}
      </div>

      <p className="aas-experimental-demo-boundary">EXPERIMENTAL AAS EVOLUTION — NOT OPERATIONAL PPU STATE</p>

      {sequenceStep >= 0 ? (
        <section className="aas-experimental-demo-history" aria-labelledby="aas-experimental-demo-history-title">
          <h6 id="aas-experimental-demo-history-title">Experimental sequence history</h6>
          <ol>
            {evolutionSteps.slice(0, sequenceStep + 1).map((step) => (
              <li key={step.id}>
                <strong>{step.label}</strong>
                <span>{step.capabilityCount} capabilities · {step.evolution.status}</span>
                <code>{step.documentHash}</code>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {editableRefresh?.snapshot ? <small>Previous valid functional snapshot retained in this demonstration session.</small> : null}
      {refreshState.error ? (
        <p className="aas-experimental-demo-error" role="alert">Refresh rejected: {refreshState.error}. Last valid snapshot preserved.</p>
      ) : null}

      {editableRefresh?.diagnostics ? (
        <details className="aas-experimental-demo-diagnostics">
          <summary>Refresh AAS Diagnostics</summary>
          <dl>
            <dt>Session</dt><dd>{editableRefresh.diagnostics.sessionId}</dd>
            <dt>Session reset</dt><dd>{editableRefresh.diagnostics.sessionReset ? 'YES — no previous snapshot' : 'NO'}</dd>
            <dt>Server instance</dt><dd>{editableRefresh.diagnostics.serverInstanceId}</dd>
            <dt>Previous document hash</dt><dd><code>{editableRefresh.diagnostics.previousDocumentHash || '—'}</code></dd>
            <dt>Current document hash</dt><dd><code>{editableRefresh.diagnostics.currentDocumentHash}</code></dd>
            <dt>Previous functional hash</dt><dd><code>{editableRefresh.diagnostics.previousFunctionalHash || '—'}</code></dd>
            <dt>Current functional hash</dt><dd><code>{editableRefresh.diagnostics.currentFunctionalHash}</code></dd>
            <dt>Previous capability count</dt><dd>{editableRefresh.diagnostics.previousCapabilityCount ?? '—'}</dd>
            <dt>Current capability count</dt><dd>{editableRefresh.diagnostics.currentCapabilityCount}</dd>
            <dt>Evolution</dt><dd>{editableRefresh.diagnostics.evolutionStatus}</dd>
            <dt>Differences</dt><dd>{editableRefresh.diagnostics.differenceTypes.length ? editableRefresh.diagnostics.differenceTypes.join(', ') : '—'}</dd>
            <dt>Current projection hash</dt><dd><code>{editableRefresh.diagnostics.currentProjectionHash}</code></dd>
          </dl>
        </details>
      ) : null}

      <AasFunctionalCapabilitiesPreview
        key={view === 'refresh' ? editableRefresh?.projection?.contentHash : view === 'sequence' ? selectedStep?.documentHash : view}
        cpsId={cpsId}
        documentProjectionOverride={view === 'refresh' ? editableRefresh?.projection : view === 'sequence' ? selectedStep?.projection : null}
        documentEvolution={view === 'refresh' ? editableRefresh?.evolution : view === 'sequence' ? selectedStep?.evolution : null}
        experimentalDocument={view === 'refresh' || view === 'sequence'}
      />
    </section>
  );
}
