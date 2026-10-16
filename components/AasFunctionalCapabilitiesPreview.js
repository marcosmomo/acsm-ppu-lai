'use client';

import React from 'react';
import officialProjection from '../docs/experiments/int-evo-7-cpslai1-official-aas-projection.json' with { type: 'json' };
import {
  buildAasFunctionalCardPresentation,
  buildAasFunctionalCardPresentationFromCycleQuery,
  buildFunctionalChangesPresentation,
} from '../lib/evolution/aasFunctionalCardPresentation.mjs';

const documentProjection = {
  ...officialProjection.document,
  verifiedContentHash: officialProjection.verification?.catalogContentHash,
};

const attributeValue = (attribute) => String(attribute?.value ?? '—');

function stateMessage(presentation) {
  switch (presentation.state) {
    case 'DOCUMENT_PREVIEW': return 'AAS DOCUMENT AVAILABLE — NOT BOUND TO PPU CYCLE';
    case 'BOUND': return `AAS BOUND TO PPU CYCLE — ${presentation.binding.plugCycleId}`;
    case 'CONFLICT': return `AAS CYCLE CORRELATION CONFLICT — ${presentation.reason}`;
    default: return 'AAS CONFIGURATION UNAVAILABLE';
  }
}

export default function AasFunctionalCapabilitiesPreview({
  cpsId,
  binding = null,
  cycleReadModel = null,
  evolutionCycleProjection = null,
  documentProjectionOverride = null,
  documentEvolution = null,
  experimentalDocument = false,
}) {
  const selectedDocument = documentProjectionOverride || documentProjection;
  const presentation = evolutionCycleProjection
    ? buildAasFunctionalCardPresentationFromCycleQuery({ cpsId, projection: evolutionCycleProjection })
    : buildAasFunctionalCardPresentation({ cpsId, document: selectedDocument, binding, cycleReadModel });
  const preview = presentation.aas;
  const experimentalCycle = presentation.state === 'BOUND' &&
    String(preview?.sourceType || '').toUpperCase().includes('EXPERIMENTAL');
  const evolutionAvailable = presentation.state === 'BOUND' &&
    !['NOT_AVAILABLE', 'EVOLUTION_NOT_PROCESSED', 'UNAVAILABLE', 'CONFLICT']
      .includes(presentation.evolution?.status);
  const functionalChanges = evolutionAvailable || (experimentalDocument && presentation.state === 'DOCUMENT_PREVIEW')
    ? buildFunctionalChangesPresentation(documentEvolution || presentation.evolution)
    : null;

  return (
    <section className="aas-functional-preview" aria-labelledby="aas-functional-preview-title">
      <div className="aas-functional-preview-header">
        <div>
          <span className="aas-functional-preview-kicker">AAS FUNCTIONAL CONFIGURATION · {presentation.state}</span>
          <h5 id="aas-functional-preview-title">AAS Functional Capabilities — CPS-LAI-01</h5>
          <p className="aas-functional-preview-boundary">{stateMessage(presentation)}</p>
        </div>
        <span className="aas-functional-preview-warning">DECLARED ONLY — NOT PHYSICALLY VERIFIED</span>
      </div>

      {experimentalCycle ? (
        <p className="aas-functional-preview-experimental">EXPERIMENTAL PPU CYCLE — NOT OPERATIONAL STATE</p>
      ) : null}

      {experimentalDocument ? (
        <p className="aas-functional-preview-experimental">EXPERIMENTAL AAS DOCUMENT — NOT OPERATIONAL PPU STATE</p>
      ) : null}

      {presentation.state === 'CONFLICT' || presentation.state === 'UNAVAILABLE' ? (
        <p className="aas-functional-preview-empty">{stateMessage(presentation)}</p>
      ) : null}

      {preview ? <>
        {presentation.state === 'DOCUMENT_PREVIEW' ? (
          <p className="aas-functional-preview-document-only">DOCUMENT PREVIEW ONLY — THIS DOES NOT ASSERT A PPU CYCLE BINDING.</p>
        ) : null}
        <dl className="aas-functional-preview-identity">
          <dt>CPS</dt><dd>{preview.cpsId}</dd>
          <dt>AAS version</dt><dd>{preview.version || 'Not declared'}</dd>
          <dt>AAS ID</dt><dd>{preview.aasId}</dd>
          <dt>Asset ID</dt><dd>{preview.assetId}</dd>
          <dt>Source</dt><dd>{preview.sourceType} · {preview.sourceId}</dd>
          <dt>Evidence</dt><dd>{preview.evidenceLevel}</dd>
          <dt>Total</dt><dd>{preview.capabilities.length} capabilities</dd>
          <dt>Binding</dt><dd>{presentation.state === 'BOUND' ? 'CORRELATED' : 'NOT BOUND'}</dd>
          {presentation.state === 'BOUND' ? <><dt>Plug cycle</dt><dd>{presentation.binding.plugCycleId}</dd></> : null}
        </dl>
        <details className="aas-functional-preview-hash">
          <summary>SHA-256 {preview.contentHash.slice(0, 12)}…</summary>
          <code>{preview.contentHash}</code>
        </details>

        <div className="aas-functional-preview-capabilities">
          {preview.capabilities.map((capability) => (
            <article key={capability.identity} className="aas-functional-preview-capability">
              <h6>{capability.name}</h6>
              <code>{capability.identity}</code>
              <ul>
                {Object.entries(capability.attributes || {}).map(([name, attribute]) => {
                  const value = attributeValue(attribute);
                  return (
                    <li key={name} className={value === 'true' ? 'is-supported' : value === 'false' ? 'is-not-supported' : ''}>
                      <span>{name}</span><strong>{value}</strong>
                    </li>
                  );
                })}
              </ul>
              <small>{capability.evidenceLevel || 'DECLARED_ONLY'}</small>
            </article>
          ))}
        </div>

        <details className="aas-functional-preview-services">
          <summary>Declared services ({preview.services.length})</summary>
          <div>{preview.services.map((service) => <span key={service.identity}>{service.name}</span>)}</div>
        </details>
        {functionalChanges ? (
          <section className="aas-functional-changes" aria-labelledby="aas-functional-changes-title">
            <div className="aas-functional-changes-header">
              <h6 id="aas-functional-changes-title">Functional Changes Detected</h6>
              <strong>{functionalChanges.status}</strong>
            </div>
            {functionalChanges.message ? <p>{functionalChanges.message}</p> : null}
            {functionalChanges.differences.map((difference, index) => (
              <article key={`${difference.type}-${difference.identity || index}`} className={`is-${difference.type.toLowerCase()}`}>
                <header><span>{difference.type}</span><strong>{difference.name}</strong><small>{difference.kind}</small></header>
                {difference.attributes.map((attribute) => (
                  <dl key={attribute.name}>
                    <dt>{attribute.name}</dt>
                    <dd><span>Before: {String(attribute.before ?? '—')}</span><span>Current: {String(attribute.current ?? '—')}</span></dd>
                  </dl>
                ))}
              </article>
            ))}
          </section>
        ) : null}
      </> : null}
    </section>
  );
}
