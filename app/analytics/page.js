'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import CPSAnalyticsFromContext from '../../components/CPSAnalyticsFromContext';
import {
  getActiveAcsmConfig,
  getManagedCpsIdsForAcsm,
  normalizeCpsId,
} from '../../lib/acsm/config';
import { sanitizeTextEncoding } from '../../lib/text/sanitizeTextEncoding';

const activeAcsm = getActiveAcsmConfig();

function AnalyticsContent() {
  const searchParams = useSearchParams();
  const allowedCpsIds = getManagedCpsIdsForAcsm(activeAcsm);
  const defaultCpsId = normalizeCpsId(activeAcsm.defaultCpsId);
  const requestedId = searchParams.get('cpsId');
  const normalizedRequestedId = normalizeCpsId(requestedId);
  const hasRequestedId = Boolean(normalizedRequestedId);
  const isRequestedIdAllowed = allowedCpsIds.includes(normalizedRequestedId);
  const resolvedCpsId = isRequestedIdAllowed ? normalizedRequestedId : defaultCpsId;
  const cpsId = resolvedCpsId;

  if (!hasRequestedId) {
    console.warn('[ACSM Analytics] Missing cpsId query parameter. Using configured default.', {
      requestedId,
      normalizedRequestedId,
      allowedCpsIds,
      defaultCpsId,
      resolvedCpsId,
    });
  } else if (!isRequestedIdAllowed) {
    console.warn('[ACSM Analytics] Requested cpsId is outside the active ACSM scope.', {
      requestedId,
      normalizedRequestedId,
      allowedCpsIds,
      defaultCpsId,
      resolvedCpsId,
    });
  } else {
    console.log('[ACSM Analytics] Resolved cpsId from query parameter.', {
      requestedId,
      normalizedRequestedId,
      allowedCpsIds,
      defaultCpsId,
      resolvedCpsId,
    });
  }

  const cpsName =
    searchParams.get('cpsName') && isRequestedIdAllowed
      ? sanitizeTextEncoding(searchParams.get('cpsName'), { fallback: cpsId })
      : cpsId;

  return (
    <main
      style={{
        padding: 28,
        minHeight: '100vh',
        background:
          'radial-gradient(circle at top left, rgba(59,130,246,0.10), transparent 20%), linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)',
      }}
    >
      <div style={{ maxWidth: 1480, margin: '0 auto' }}>
        <div
          style={{
            marginBottom: 22,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 13,
                color: '#475569',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {activeAcsm.code} - Analytics Dashboard
            </div>

            <div style={{ marginTop: 8, color: '#64748b', fontSize: 15 }}>
              Analytical monitoring and learning for the industrial asset in the current ACSM scope.
            </div>
          </div>

          <button
            type="button"
            onClick={() => window.history.back()}
            style={{
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              color: '#0f172a',
              borderRadius: 14,
              padding: '12px 18px',
              fontWeight: 800,
              cursor: 'pointer',
              boxShadow: '0 8px 20px rgba(15,23,42,0.06)',
            }}
          >
            Voltar
          </button>
        </div>

        <CPSAnalyticsFromContext cpsId={cpsId} title={cpsName} />
      </div>
    </main>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 28, textAlign: 'center', fontWeight: 'bold' }}>
          Loading automation dashboard...
        </div>
      }
    >
      <AnalyticsContent />
    </Suspense>
  );
}
