'use client';

import React from 'react';
import { Brain, CheckCircle2, Gauge, Lightbulb, ShieldAlert, TimerReset } from 'lucide-react';
import { sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';

const DASH = '-';

const text = (value, fallback = DASH) => sanitizeTextEncoding(value, { fallback });

const fieldLabels = [
  ['diagnosis', 'Diagnosis', Gauge, 'indicatorInterpretation'],
  ['prediction', 'Prediction', TimerReset, 'temporalDynamics'],
  ['riskInterpretation', 'Risk interpretation', ShieldAlert, 'riskAssessment'],
  ['decisionJustification', 'Decision justification', CheckCircle2, 'operationalImplication'],
  ['confidenceInterpretation', 'Confidence interpretation', Brain, 'confidenceNote'],
];

function AnalysisField({ icon: Icon, label, value }) {
  if (!value) return null;

  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        padding: 14,
        background: '#ffffff',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          color: '#334155',
          fontSize: 12,
          fontWeight: 800,
          textTransform: 'uppercase',
        }}
      >
        <Icon size={16} />
        <span>{label}</span>
      </div>
      <div style={{ color: '#475569', lineHeight: 1.65, overflowWrap: 'anywhere' }}>
        {text(value)}
      </div>
    </div>
  );
}

export default function AIAnalysisPanel({
  analysis,
  mode = 'light',
  source = 'live',
  timestamp,
  title = 'Generative AI interpretation',
}) {
  const hasAnalysis = analysis && typeof analysis === 'object' && Object.keys(analysis).length > 0;
  const normalizedMode = mode === 'full' ? 'full' : 'light';
  const normalizedSource = source === 'fallback' ? 'fallback' : 'live';
  const isFull = normalizedMode === 'full';
  const sourceLabel =
    normalizedSource === 'fallback'
      ? 'Fallback status: active'
      : 'Fallback status: inactive';
  const sourceColors =
    normalizedSource === 'fallback'
      ? {
          background: '#fef3c7',
          color: '#92400e',
          border: '#fcd34d',
        }
      : {
          background: '#dcfce7',
          color: '#166534',
          border: '#bbf7d0',
        };

  if (!hasAnalysis) {
    return (
      <section
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: 18,
          background: '#f8fafc',
          color: '#475569',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, color: '#0f172a' }}>
          <Brain size={18} />
          <span>{title}</span>
        </div>
        <div style={{ marginTop: 10, lineHeight: 1.6 }}>
          No enriched AI analysis has been received for this CPS yet.
        </div>
      </section>
    );
  }

  const getValue = (primary, legacy) => analysis?.[primary] || analysis?.[legacy];

  return (
    <section
      style={{
        border: '1px solid #dbeafe',
        borderRadius: 8,
        padding: 18,
        background: '#f8fafc',
        boxShadow: '0 12px 28px rgba(15,23,42,0.06)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              background: '#eff6ff',
              color: '#1d4ed8',
              border: '1px solid #bfdbfe',
            }}
          >
            <Brain size={20} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#0f172a' }}>{title}</div>
            <div style={{ marginTop: 3, fontSize: 12, color: '#64748b' }}>
              {timestamp ? `Last update: ${new Date(timestamp).toLocaleString('pt-BR')}` : 'Last update unavailable'}
            </div>
          </div>
        </div>
        <span
          style={{
            padding: '7px 11px',
            borderRadius: 8,
            background: sourceColors.background,
            color: sourceColors.color,
            border: `1px solid ${sourceColors.border}`,
            fontSize: 12,
            fontWeight: 900,
            textTransform: 'uppercase',
          }}
        >
          {sourceLabel}
        </span>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        <AnalysisField icon={Brain} label="Summary" value={analysis.summary} />
        <AnalysisField icon={Lightbulb} label="Recommendation" value={analysis.recommendation} />
      </div>

      {isFull ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
            marginTop: 12,
          }}
        >
          {fieldLabels.map(([key, label, Icon, legacyKey]) => (
            <AnalysisField key={key} icon={Icon} label={label} value={getValue(key, legacyKey)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
