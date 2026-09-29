'use client';

import React, { useEffect, useState } from 'react';
import { normalizeCpsId } from '../lib/acsm/config';
import { sanitizeTextDeep, sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';

const txt = (value, fallback = '-') => sanitizeTextEncoding(value, { fallback });
const NODE_RED_BASE_URL = process.env.NEXT_PUBLIC_NODE_RED_BASE_URL || 'http://localhost:1881';

export default function CPSDescription({ cps }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const cpsId = normalizeCpsId(cps?.id);
  const API =
    cps?.endpoints?.description ||
    (cpsId ? `${NODE_RED_BASE_URL}/api/${cpsId}/discovery` : null);

  useEffect(() => {
    if (!API) {
      setLoading(false);
      return undefined;
    }

    async function load() {
      try {
        const res = await fetch(API);
        const json = await res.json();
        setData(sanitizeTextDeep(json));
        setLoading(false);
      } catch (err) {
        console.error('Error loading CPS', err);
      }
    }

    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [API]);

  if (loading) return <div>Loading CPS...</div>;
  if (!data) return <div>Description endpoint unavailable for this CPS.</div>;

  const runtime = data.runtime || {};
  const docs = data.documentation || {};

  return (
    <div style={{ padding: 20, background: '#f3f6fa' }}>
      <h2>{txt(data.cpsName)} - Description</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
          <h3>Asset Documentation</h3>
          <p><b>CPS ID:</b> {txt(data.cpsId)}</p>
          <p><b>Tipo:</b> {txt(data.assetType)}</p>
          <p><b>Fabricante:</b> {txt(data.manufacturer)}</p>
          <p><b>ECLASS:</b> {txt(data.eclass)}</p>
          <p><b>Feature:</b> {txt(data.feature)}</p>

          <hr />

          <a href={`${NODE_RED_BASE_URL}${docs?.datasheet?.publicUrl}`} target="_blank">
            Open Datasheet
          </a>

          <br />
          <br />

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${NODE_RED_BASE_URL}${docs?.thumbnail?.publicUrl}`}
            alt={`Thumbnail do ${txt(data.cpsName || data.cpsId || 'CPS')}`}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
          <h3>Status Operacional</h3>
          <p><b>Status:</b> {txt(runtime.status?.status)}</p>
          <p><b>Modo:</b> {txt(runtime.status?.mode)}</p>

          <hr />

          <h4>Health</h4>
          <p>Score: {txt(runtime.health?.healthScore)}</p>
          <p>Label: {txt(runtime.health?.healthLabel)}</p>

          <hr />

          <h4>OEE</h4>
          <p>Availability: {(Number(runtime.oee?.availability || 0) * 100).toFixed(1)}%</p>
          <p>Performance: {(Number(runtime.oee?.performance || 0) * 100).toFixed(1)}%</p>
          <p>Quality: {(Number(runtime.oee?.quality || 0) * 100).toFixed(1)}%</p>
          <p><b>OEE:</b> {(Number(runtime.oee?.oee || 0) * 100).toFixed(1)}%</p>
        </div>
      </div>
    </div>
  );
}
