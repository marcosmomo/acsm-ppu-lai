'use client';

import HCMPanel from '../../components/HCMPanel';

export default function HCMPage() {
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
              ACSM - Hierarchical Cognitive Memory
            </div>

            <div style={{ marginTop: 8, color: '#64748b', fontSize: 15 }}>
              Episodes, CPS knowledge items, and human curation records.
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

        <HCMPanel />
      </div>
    </main>
  );
}
