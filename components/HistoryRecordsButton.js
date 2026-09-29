'use client';

import React, { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_NODE_RED_BASE_URL || 'http://localhost:1881';

function getNestedValue(record, keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((current, part) => current?.[part], record);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function summarizeRecord(record) {
  return {
    temporalState:
      record?.temporalState ||
      getNestedValue(record?.payload || {}, [
        'adaptiveLearningCps.temporalState',
        'adaptiveLearningLocal.temporalState',
        'adaptiveLearningService.temporalState',
        'adaptiveLearning.temporalState',
      ]),
    adaptiveAction:
      record?.adaptiveAction ||
      getNestedValue(record?.payload || {}, [
        'adaptiveLearningCps.adaptiveAction',
        'adaptiveLearningLocal.adaptiveAction',
        'adaptiveLearningService.adaptiveAction',
        'adaptiveLearning.adaptiveAction',
        'globalDirectives.adaptiveAction',
      ]),
  };
}

export default function HistoryRecordsButton({ level, label = 'Last 25 records', variant = 'light' }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [state, setState] = useState({ loading: false, error: '', records: [] });
  const isDark = variant === 'dark';

  async function loadRecords() {
    setOpen(true);
    setState({ loading: true, error: '', records: [] });
    try {
      const res = await fetch(`${API_BASE}/api/history/${level}?limit=25`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ loading: false, error: '', records: Array.isArray(data.records) ? data.records : [] });
    } catch (err) {
      setState({ loading: false, error: err?.message || 'Could not load history records.', records: [] });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={loadRecords}
        style={{
          justifySelf: 'start',
          border: isDark ? '1px solid rgba(255,255,255,0.18)' : '1px solid #cbd5e1',
          background: isDark ? 'rgba(255,255,255,0.10)' : '#ffffff',
          color: isDark ? '#f8fafc' : '#0f172a',
          borderRadius: 10,
          padding: '8px 11px',
          fontSize: 12,
          fontWeight: 900,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>

      {open ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15,23,42,0.58)',
            display: 'grid',
            placeItems: 'center',
            padding: 18,
          }}
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width: 'min(980px, 100%)',
              maxHeight: '82vh',
              overflow: 'auto',
              borderRadius: 18,
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              boxShadow: '0 28px 90px rgba(15,23,42,0.32)',
              padding: 18,
              display: 'grid',
              gap: 12,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: '#64748b', fontWeight: 900, textTransform: 'uppercase' }}>
                  {level} history
                </div>
                <div style={{ fontSize: 20, fontWeight: 900, color: '#0f172a' }}>Last 25 records</div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  border: '1px solid #cbd5e1',
                  background: '#f8fafc',
                  color: '#0f172a',
                  borderRadius: 10,
                  padding: '8px 11px',
                  fontWeight: 900,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>

            {state.loading ? <div style={{ color: '#64748b' }}>Loading records...</div> : null}
            {state.error ? <div style={{ color: '#b91c1c', fontWeight: 800 }}>History unavailable: {state.error}</div> : null}
            {!state.loading && !state.error && !state.records.length ? (
              <div style={{ color: '#64748b' }}>No records found for this level.</div>
            ) : null}

            <div style={{ display: 'grid', gap: 8 }}>
              {state.records.map((record, index) => {
                const summary = summarizeRecord(record);
                const key = record.id || `${record.ts || record.timestamp || index}-${index}`;
                return (
                  <div
                    key={key}
                    style={{
                      border: '1px solid #e2e8f0',
                      borderRadius: 12,
                      padding: 11,
                      background: '#f8fafc',
                      display: 'grid',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '155px 100px 90px minmax(0, 1fr) minmax(0, 1fr) auto',
                        gap: 8,
                        alignItems: 'center',
                        fontSize: 12,
                        color: '#475569',
                      }}
                    >
                      <strong style={{ color: '#0f172a' }}>{record.timestamp || '-'}</strong>
                      <span>{record.source || '-'}</span>
                      <span>{record.kind || '-'}</span>
                      <span style={{ overflowWrap: 'anywhere' }}>{record.messageType || '-'}</span>
                      <span style={{ overflowWrap: 'anywhere' }}>
                        {summary.temporalState || '-'} {summary.adaptiveAction ? `| ${summary.adaptiveAction}` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                        style={{
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          borderRadius: 8,
                          padding: '6px 8px',
                          fontSize: 11,
                          fontWeight: 900,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {expanded[key] ? 'Hide payload' : 'Payload'}
                      </button>
                    </div>

                    {expanded[key] ? (
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 260,
                          overflow: 'auto',
                          borderRadius: 10,
                          background: '#0f172a',
                          color: '#e2e8f0',
                          padding: 12,
                          fontSize: 11,
                          lineHeight: 1.5,
                        }}
                      >
                        {JSON.stringify(record.payload || {}, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
