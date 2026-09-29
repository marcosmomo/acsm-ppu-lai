'use client';

import React, { useCallback, useEffect, useState } from 'react';

export default function ApiCatalogModal({ open, onClose }) {
  const [inspection, setInspection] = useState({
    state: 'idle', data: null, httpStatus: null, error: null,
  });
  const [copyFeedback, setCopyFeedback] = useState('');

  const loadCatalog = useCallback(async () => {
    setInspection((current) => ({ ...current, state: 'loading', error: null }));
    setCopyFeedback('');
    try {
      const response = await fetch('/api/acsm', { method: 'GET', cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), {
          httpStatus: response.status,
        });
      }
      setInspection({ state: 'success', data, httpStatus: response.status, error: null });
    } catch (error) {
      setInspection({
        state: 'error', data: null, httpStatus: error?.httpStatus ?? null,
        error: error?.message || 'Unknown error',
      });
    }
  }, []);

  useEffect(() => {
    if (open) loadCatalog();
  }, [open, loadCatalog]);

  const copyJson = async () => {
    if (!inspection.data || !navigator?.clipboard) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(inspection.data, null, 2));
      setCopyFeedback('Copied');
    } catch {
      setCopyFeedback('Copy failed');
    }
  };

  if (!open) return null;

  const facades = Array.isArray(inspection.data?.availableFacades)
    ? inspection.data.availableFacades
    : [];
  const operations = Object.entries(inspection.data?.lifecycleOperations || {});

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal play-api-modal api-catalog-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-catalog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="api-catalog-title" className="details-modal-title">ACSM API Catalog</h3>
        <div className="play-api-meta">
          <div><strong>Endpoint:</strong> <code>GET /api/acsm</code></div>
          <div>
            <strong>Status:</strong>{' '}
            {inspection.httpStatus
              ? `${inspection.httpStatus}${inspection.httpStatus === 200 ? ' OK' : ''}`
              : '—'}
          </div>
          <div><strong>Last update:</strong> {inspection.data?.timestamp || '—'}</div>
          <div><strong>Source:</strong> ACSM API Catalog</div>
        </div>

        {inspection.state === 'loading' ? (
          <div className="play-api-message" role="status">Loading API Catalog...</div>
        ) : null}
        {inspection.state === 'error' ? (
          <div className="play-api-error" role="alert">
            <strong>Unable to load GET /api/acsm</strong>
            <span>
              {inspection.httpStatus ? `HTTP ${inspection.httpStatus}: ` : ''}
              {inspection.error}
            </span>
          </div>
        ) : null}

        {inspection.state === 'success' ? (
          <div className="api-catalog-content">
            <section className="api-catalog-section" aria-labelledby="available-facades-title">
              <h4 id="available-facades-title">Available Facades</h4>
              <div className="api-catalog-facades">
                {facades.map((facade) => (
                  <article className="api-catalog-card" key={facade.endpoint}>
                    <strong>{facade.name}</strong>
                    <code>{facade.method} {facade.endpoint}</code>
                    <span>{facade.readOnly ? 'Read-only' : 'Write enabled'}</span>
                    <span>{String(facade.type || '').replaceAll('-', ' ')}</span>
                    <p>{facade.description}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="api-catalog-section" aria-labelledby="without-facade-title">
              <h4 id="without-facade-title">No Dedicated Facade</h4>
              <div className="api-catalog-operations">
                {operations.map(([operation, descriptor]) => (
                  <div className="api-catalog-operation" key={operation}>
                    <strong>{operation}</strong>
                    <span>{descriptor.reason}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="api-catalog-raw" aria-labelledby="api-catalog-raw-title">
              <h4 id="api-catalog-raw-title">Raw JSON</h4>
              <pre className="play-api-json">{JSON.stringify(inspection.data, null, 2)}</pre>
            </section>
          </div>
        ) : null}

        <div className="modal-footer play-api-modal-footer">
          {copyFeedback ? <span className="play-api-copy-feedback">{copyFeedback}</span> : null}
          <button
            className="play-dashboard-btn"
            onClick={loadCatalog}
            disabled={inspection.state === 'loading'}
          >
            Refresh
          </button>
          <button
            className="play-dashboard-btn"
            onClick={copyJson}
            disabled={inspection.state !== 'success' || !inspection.data}
          >
            Copy JSON
          </button>
          <button className="modal-cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
