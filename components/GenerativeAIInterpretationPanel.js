'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import AIAnalysisPanel from './AIAnalysisPanel';

const stripVolatileFields = (value) => {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'ts',
            'timestamp',
            'generatedAt',
            'updatedAt',
            'lastUpdate',
            'aiLastUpdate',
          ].includes(key)
      )
      .map(([key, item]) => [key, stripVolatileFields(item)])
  );
};

const hasPackageContent = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0;

function LoadingPanel({ title }) {
  return (
    <section
      style={{
        border: '1px solid #dbeafe',
        borderRadius: 8,
        padding: 18,
        background: '#f8fafc',
        color: '#475569',
      }}
    >
      <div style={{ fontWeight: 900, color: '#0f172a' }}>{title}</div>
      <div style={{ marginTop: 8, lineHeight: 1.6 }}>
        Generating natural-language interpretation from the current knowledge package...
      </div>
    </section>
  );
}

function ErrorPanel({ title, message }) {
  return (
    <section
      style={{
        border: '1px solid #fecaca',
        borderRadius: 8,
        padding: 18,
        background: '#fef2f2',
        color: '#991b1b',
      }}
    >
      <div style={{ fontWeight: 900 }}>{title}</div>
      <div style={{ marginTop: 8, lineHeight: 1.6 }}>
        Generative interpretation is unavailable. Existing analytics remain unchanged.
      </div>
      {message ? <div style={{ marginTop: 6, fontSize: 13 }}>{message}</div> : null}
    </section>
  );
}

export default function GenerativeAIInterpretationPanel({
  level,
  contextType,
  knowledgePackage,
  language = 'en',
  outputType = 'summary',
  title = 'Generative AI interpretation',
}) {
  const [analysis, setAnalysis] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const lastSignatureRef = useRef('');

  const requestSignature = useMemo(() => {
    if (!hasPackageContent(knowledgePackage)) return '';
    return JSON.stringify({
      level,
      contextType,
      language,
      outputType,
      knowledgePackage: stripVolatileFields(knowledgePackage),
    });
  }, [contextType, knowledgePackage, language, level, outputType]);

  useEffect(() => {
    if (!requestSignature) {
      setAnalysis(null);
      setStatus('idle');
      setError('');
      lastSignatureRef.current = '';
      return undefined;
    }

    if (lastSignatureRef.current === requestSignature) return undefined;
    lastSignatureRef.current = requestSignature;

    const controller = new AbortController();
    setStatus('loading');
    setError('');

    const run = async () => {
      try {
        const response = await fetch('/api/ai/describe-level', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            level,
            contextType,
            knowledgePackage,
            language,
            outputType,
          }),
          cache: 'no-store',
          signal: controller.signal,
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload) {
          throw new Error(payload?.error || 'Generative interpretation request failed.');
        }

        setAnalysis(payload);
        setStatus('ready');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setError(err?.message || 'Generative interpretation request failed.');
        setStatus('error');
      }
    };

    run();

    return () => {
      controller.abort();
    };
  }, [contextType, knowledgePackage, language, level, outputType, requestSignature]);

  if (!requestSignature) {
    return (
      <AIAnalysisPanel
        analysis={null}
        mode="full"
        source="fallback"
        title={title}
      />
    );
  }

  if (status === 'loading' && !analysis) {
    return <LoadingPanel title={title} />;
  }

  if (status === 'error' && !analysis) {
    return <ErrorPanel title={title} message={error} />;
  }

  return (
    <AIAnalysisPanel
      analysis={analysis}
      mode="full"
      source={analysis?.fallback ? 'fallback' : 'live'}
      timestamp={analysis?.generatedAt || analysis?.timestamp}
      title={title}
    />
  );
}
