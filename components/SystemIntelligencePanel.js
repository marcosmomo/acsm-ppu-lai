import React from 'react';

const EMPTY = '-';

const n = (v, fallback = null) => {
  const value = Number(v);
  return Number.isFinite(value) ? value : fallback;
};

const pct = (v) => {
  const value = n(v);
  return value === null ? EMPTY : `${(value * 100).toFixed(1)}%`;
};

const score = (v) => {
  const value = n(v);
  return value === null ? EMPTY : value.toFixed(2);
};

const text = (v, fallback = EMPTY) => {
  if (v === null || v === undefined || v === '') return fallback;
  if (Array.isArray(v)) return v.filter(Boolean).join(', ') || fallback;
  if (typeof v === 'object') return v.cpsId || v.id || v.name || fallback;
  return String(v);
};

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);

const tone = (v) => {
  const s = String(v || '').toLowerCase();
  if (s.includes('high') || s.includes('critical') || s.includes('degraded') || s.includes('degrading')) return 'bad';
  if (s.includes('medium') || s.includes('unstable') || s.includes('attention') || s.includes('below')) return 'warn';
  if (s.includes('low') || s.includes('stable') || s.includes('normal') || s.includes('improving')) return 'good';
  return 'neutral';
};

const badge = (kind = 'neutral') => ({
  display: 'inline-flex',
  maxWidth: '100%',
  padding: '7px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1.25,
  wordBreak: 'break-word',
  ...(kind === 'good'
    ? { background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' }
    : kind === 'warn'
      ? { background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }
      : kind === 'bad'
        ? { background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }
        : kind === 'info'
          ? { background: '#dbeafe', color: '#1d4ed8', border: '1px solid #bfdbfe' }
          : { background: '#f1f5f9', color: '#334155', border: '1px solid #e2e8f0' }),
});

const panel = {
  borderRadius: 20,
  padding: 18,
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  boxShadow: '0 10px 30px rgba(15,23,42,0.06)',
  minWidth: 0,
};

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: 10,
};

function Field({ label, value, kind = 'neutral' }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', marginBottom: 6 }}>{label}</div>
      <span style={badge(kind)}>{text(value)}</span>
    </div>
  );
}

function Evidence({ items }) {
  const list = arr(items);
  if (!list.length) return <div style={{ color: '#64748b', fontSize: 14 }}>No system evidence available.</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {list.map((item, index) => (
        <div key={`${item}-${index}`} style={{ borderRadius: 14, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155', fontSize: 14, lineHeight: 1.5 }}>
          {text(item)}
        </div>
      ))}
    </div>
  );
}

function Ranking({ rows }) {
  const list = arr(rows);
  if (!list.length) return <div style={{ color: '#64748b', fontSize: 14 }}>No criticality ranking available.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
        <thead>
          <tr>
            {['CPS', 'Name', 'Impact', 'Dominant loss', 'State'].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((item, index) => (
            <tr key={`${item?.cpsId || item?.id || index}-${index}`}>
              <td style={{ padding: 12, borderBottom: '1px solid #f1f5f9', fontWeight: 900 }}>{text(item?.cpsId || item?.id)}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #f1f5f9' }}>{text(item?.cpsName || item?.name)}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #f1f5f9' }}><span style={badge(index === 0 ? 'bad' : index === 1 ? 'warn' : 'neutral')}>{score(item?.impactScore ?? item?.criticalityScore ?? item?.score)}</span></td>
              <td style={{ padding: 12, borderBottom: '1px solid #f1f5f9' }}>{text(item?.dominantLoss || item?.dominantDimension)}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #f1f5f9' }}><span style={badge(tone(item?.state))}>{text(item?.state)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Box({ title, children }) {
  return (
    <div style={panel}>
      <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 900, color: '#0f172a' }}>{title}</h3>
      {children}
    </div>
  );
}

export default function SystemIntelligencePanel({ analytics = {} }) {
  const globalOEE = analytics?.globalOEE || analytics?.oee || {};
  const criticalCPS = analytics?.criticalCPS || analytics?.criticalCps || {};
  const learning = analytics?.systemLearningModel || {};
  const causality = analytics?.systemCausality || {};
  const anomaly = analytics?.systemAnomaly || {};
  const forecast = analytics?.systemForecast || {};
  const reasoning = analytics?.systemReasoning || analytics?.reasoning || {};
  const evidence = analytics?.systemEvidenceList || analytics?.systemEvidence?.narrative || analytics?.coordinatorOutput?.systemEvidence || [];
  const ranking = analytics?.criticalityRanking || analytics?.criticality || analytics?.coordinatorOutput?.criticalityRanking || [];

  return (
    <section style={{ borderRadius: 24, padding: 20, background: '#f8fafc', border: '1px solid #e2e8f0', boxShadow: '0 12px 32px rgba(15,23,42,0.05)' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: '#0f172a' }}>System Intelligence</h2>
        <div style={{ marginTop: 6, color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>Systemic learning, evidence, causality, anomaly detection, forecast, and multi-CPS reasoning.</div>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <Box title="System Overview">
            <div style={grid}>
              <Field label="Global OEE" value={pct(globalOEE?.oee ?? globalOEE?.current ?? analytics?.globalOEE)} kind="info" />
              <Field label="Trend" value={analytics?.trend} kind={tone(analytics?.trend)} />
              <Field label="Risk" value={analytics?.riskLevel} kind={tone(analytics?.riskLevel)} />
              <Field label="Confidence" value={score(analytics?.confidence)} kind="info" />
              <Field label="Critical CPS" value={criticalCPS?.cpsId || criticalCPS} />
            </div>
          </Box>
          <Box title="System Intelligence">
            <div style={grid}>
              <Field label="Pattern" value={learning?.pattern} kind={tone(learning?.pattern)} />
              <Field label="Dominant loss" value={learning?.dominantLoss} kind={tone(learning?.dominantLoss)} />
              <Field label="Stability" value={learning?.stability} kind={tone(learning?.stability)} />
              <Field label="Critical CPS" value={learning?.criticalCps} />
            </div>
          </Box>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
          <Box title="Evidence"><Evidence items={evidence} /></Box>
          <Box title="Causality">
            <div style={grid}>
              <Field label="Probable cause" value={causality?.probableCause} kind={tone(causality?.probableCause)} />
              <Field label="Cause type" value={causality?.causeType} />
              <Field label="Primary driver" value={causality?.primaryDriver} kind="info" />
              <Field label="Related CPS" value={causality?.relatedCps} />
            </div>
          </Box>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
          <Box title="Prediction">
            <div style={grid}>
              <Field label="Next state" value={forecast?.nextState} kind={tone(forecast?.nextState)} />
              <Field label="Expected OEE" value={pct(forecast?.expectedOEE)} kind="info" />
              <Field label="Risk" value={forecast?.risk} kind={tone(forecast?.risk)} />
              <Field label="Confidence" value={score(forecast?.confidence)} kind="info" />
            </div>
          </Box>
          <Box title="Anomaly">
            <div style={grid}>
              <Field label="Score" value={score(anomaly?.score)} kind={tone(anomaly?.status)} />
              <Field label="Status" value={anomaly?.status} kind={tone(anomaly?.status)} />
              <Field label="Affected dimensions" value={anomaly?.affectedDimensions} />
              <Field label="Affected CPS" value={anomaly?.affectedCps} />
            </div>
          </Box>
        </div>

        <Box title="Criticality Ranking"><Ranking rows={ranking} /></Box>

        <Box title="System Reasoning">
          <div style={grid}>
            <Field label="Primary issue" value={reasoning?.primaryIssue} kind={tone(reasoning?.primaryIssue)} />
            <Field label="System state" value={reasoning?.systemState} kind={tone(reasoning?.systemState)} />
            <Field label="Dominant loss" value={reasoning?.dominantLoss} kind={tone(reasoning?.dominantLoss)} />
            <Field label="Probable cause" value={reasoning?.probableCause} kind={tone(reasoning?.probableCause)} />
          </div>
          <div style={{ marginTop: 14, display: 'grid', gap: 10, color: '#334155', lineHeight: 1.7 }}>
            <div><strong>Executive interpretation:</strong> {text(reasoning?.executiveInterpretation, 'No executive interpretation available.')}</div>
            <div><strong>Recommendation:</strong> {text(reasoning?.recommendation || analytics?.recommendation, 'No recommendation available.')}</div>
          </div>
        </Box>
      </div>
    </section>
  );
}
