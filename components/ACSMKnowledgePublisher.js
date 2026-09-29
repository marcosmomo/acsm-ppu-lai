'use client';

import React, { useMemo } from 'react';
import { useCPSContext } from '../context/CPSContext';
import { getActiveAcsmConfig } from '../lib/acsm/config';

const ACTIVE_ACSM = getActiveAcsmConfig();

const formatPercent = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(2)}%` : '-';
};

const safeText = (value, fallback = '-') => {
  const text = String(value || '').trim();
  return text || fallback;
};

export default function ACSMKnowledgePublisher() {
  const { stableSystemAnalytics, addedCPS } = useCPSContext();
  const analytics = stableSystemAnalytics || {};
  const managedCpsCount = useMemo(
    () => Object.keys(addedCPS || {}).length || ACTIVE_ACSM.managedCpsIds.length,
    [addedCPS]
  );
  const globalOee = analytics?.globalOEE?.oee ?? analytics?.globalOEE?.current ?? analytics?.oee?.oee;
  const criticalCps =
    analytics?.criticalCPS?.cpsId || analytics?.criticalCps?.cpsId || analytics?.criticalCps;
  const recommendation = analytics?.recommendation || analytics?.actionPlan?.recommendation;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section
        style={{
          borderRadius: 24,
          padding: 24,
          background: 'linear-gradient(135deg, #0f172a 0%, #16243c 100%)',
          color: '#f8fafc',
          boxShadow: '0 24px 60px rgba(15,23,42,0.16)',
        }}
      >
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#93c5fd' }}>
          Local ACSM knowledge
        </div>
        <h2 style={{ margin: '10px 0 8px', fontSize: 28 }}>
          ACSM Knowledge Publisher
        </h2>
        <p style={{ margin: 0, lineHeight: 1.6, color: '#cbd5e1' }}>
          Consolidated local knowledge from the ACSM and its managed CPS for Learning, Reasoning,
          Prediction, Recommendation, and HCM.
        </p>
      </section>

      <section
        style={{
          border: '1px solid #dbe4f0',
          borderRadius: 20,
          background: '#ffffff',
          padding: 20,
        }}
      >
        <h3 style={{ marginTop: 0, color: '#0f172a' }}>Current Local Inference</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>ACSM</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>{ACTIVE_ACSM.code}</div>
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>System OEE</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>{formatPercent(globalOee)}</div>
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>Managed CPS</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>{managedCpsCount}</div>
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>Critical CPS</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>{safeText(criticalCps)}</div>
          </div>
        </div>
        <div style={{ marginTop: 14, color: '#334155', lineHeight: 1.7 }}>
          <strong>Recommendation:</strong> {safeText(recommendation, 'No recommendation available.')}
        </div>
      </section>
    </div>
  );
}
