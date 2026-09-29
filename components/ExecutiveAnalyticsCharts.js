'use client';

import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function hasSeries(data) {
  return Array.isArray(data) && data.length > 0;
}

function pct(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return `${(numeric * 100).toFixed(digits)}%`;
}

function safeNum(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return numeric.toFixed(digits);
}

function chartTooltipStyle() {
  return {
    background: 'rgba(24, 39, 52, 0.97)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 14,
    color: '#f8f4ee',
    fontSize: 12,
    fontFamily: 'Arial, Helvetica, sans-serif',
    boxShadow: '0 12px 30px rgba(12, 20, 28, 0.24)',
  };
}

function getImpactColor(score, fallback = '#7f93a3') {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric >= 0.5) return '#9b3d2f';
  if (numeric >= 0.38) return '#c98e27';
  return '#1f8a61';
}

function getTrendStroke(lastValue, previousValue) {
  const last = Number(lastValue);
  const previous = Number(previousValue);
  if (!Number.isFinite(last) || !Number.isFinite(previous)) return '#9b3d2f';
  return last >= previous ? '#1f8a61' : '#9b3d2f';
}

export function ExecutiveOeeTrendChart({ data = [] }) {
  if (!hasSeries(data)) return null;

  const values = data
    .map((item) => Number(item?.oee))
    .filter((value) => Number.isFinite(value));

  if (!values.length) return null;

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  const rawPadding = Math.max((maxValue - minValue) * 0.35, 0.01);
  const domainMin = Math.max(0, minValue - rawPadding);
  const domainMax = Math.min(1, maxValue + rawPadding);

  const lastValue = Number(data.at(-1)?.oee);
  const previousValue = Number(data.at(-2)?.oee);
  const stroke = getTrendStroke(lastValue, previousValue);

  const activeDot =
    Number.isFinite(lastValue)
      ? { r: 5, fill: stroke, stroke: '#fff7ed', strokeWidth: 2 }
      : { r: 0 };

  return (
    <div
      style={{
        width: '100%',
        height: 190,
        borderRadius: 18,
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.44) 0%, rgba(255,255,255,0.18) 100%)',
        padding: '6px 10px 4px',
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 12, left: 8, bottom: 0 }}>
          <CartesianGrid
            stroke="rgba(28,44,56,0.06)"
            vertical={false}
            strokeDasharray="3 3"
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#6d7a84' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[domainMin, domainMax]}
            tickFormatter={(value) => pct(value, 1)}
            tick={{ fontSize: 11, fill: '#6d7a84' }}
            axisLine={false}
            tickLine={false}
            width={56}
            ticks={[
              Number(domainMin.toFixed(3)),
              Number((((domainMin + domainMax) / 2)).toFixed(3)),
              Number(domainMax.toFixed(3)),
            ]}
          />
          <Tooltip
            formatter={(value) => pct(value, 2)}
            contentStyle={chartTooltipStyle()}
            labelStyle={{ color: '#d9e5ee' }}
          />
          <Line
            type="monotone"
            dataKey="oee"
            stroke={stroke}
            strokeWidth={3.4}
            dot={false}
            activeDot={activeDot}
            isAnimationActive
            animationDuration={700}
            animationEasing="ease-out"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ExecutiveMiniTrendChart({
  data = [],
  dataKey = 'value',
  stroke = '#9b3d2f',
  label = '',
}) {
  if (!hasSeries(data)) return null;

  return (
    <div
      style={{
        borderRadius: 16,
        padding: '12px 12px 8px',
        background: 'rgba(255,255,255,0.56)',
        border: '1px solid rgba(91,76,62,0.08)',
        boxShadow: '0 10px 20px rgba(67, 50, 38, 0.05)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 4,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#6d7a84',
          fontFamily: 'Arial, Helvetica, sans-serif',
        }}
      >
        <span>{label}</span>
        <span>{pct(data.at(-1)?.[dataKey])}</span>
      </div>

      <div style={{ width: '100%', height: 58 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 2, left: 2, bottom: 0 }}>
            <Tooltip
              formatter={(value) => pct(value)}
              contentStyle={chartTooltipStyle()}
              labelStyle={{ color: '#d9e5ee' }}
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={stroke}
              strokeWidth={2.2}
              dot={false}
              activeDot={{ r: 3, fill: stroke, stroke: '#fff7ed', strokeWidth: 1.5 }}
              isAnimationActive
              animationDuration={650}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function ExecutiveApqChart({ data = [] }) {
  if (!hasSeries(data)) return null;

  return (
    <div
      style={{
        width: '100%',
        height: 178,
        borderRadius: 18,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.40) 0%, rgba(255,255,255,0.18) 100%)',
        padding: '4px 6px 0',
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 8, left: -14, bottom: 0 }} barSize={26}>
          <CartesianGrid stroke="rgba(28,44,56,0.05)" vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#6d7a84' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(value) => pct(value, 0)}
            tick={{ fontSize: 11, fill: '#6d7a84' }}
            axisLine={false}
            tickLine={false}
            width={38}
          />
          <Tooltip
            formatter={(value) => pct(value)}
            contentStyle={chartTooltipStyle()}
            labelStyle={{ color: '#d9e5ee' }}
          />
          <Bar
            dataKey="value"
            radius={[10, 10, 3, 3]}
            isAnimationActive
            animationDuration={700}
            animationEasing="ease-out"
          >
            {data.map((entry) => (
              <Cell key={entry.label} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ExecutiveRankingChart({ data = [] }) {
  if (!hasSeries(data)) return null;

  const enriched = data.map((entry, index) => {
    const score = Number(entry?.score);
    const fullLabel = entry?.fullLabel || entry?.label || `CPS ${index + 1}`;
    const label = entry?.label || fullLabel;
    const fill = getImpactColor(score, entry?.color || '#7f93a3');

    return {
      ...entry,
      label,
      fullLabel,
      fill,
      isTop: index === 0,
      score,
    };
  });

  return (
    <div
      style={{
        width: '100%',
        height: 230,
        borderRadius: 18,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.40) 0%, rgba(255,255,255,0.18) 100%)',
        padding: '6px 8px 2px',
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={enriched}
          margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
          barCategoryGap={18}
        >
          <CartesianGrid stroke="rgba(28,44,56,0.08)" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 'dataMax + 0.05']}
            tick={{ fontSize: 11, fill: '#6d7a84' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fontSize: 11, fill: '#445561', fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
            width={60}
          />
          <Tooltip
            formatter={(value, _name, item) => [
              `Score ${safeNum(value, 3)}`,
              item?.payload?.fullLabel || 'CPS',
            ]}
            contentStyle={chartTooltipStyle()}
            labelStyle={{ color: '#d9e5ee' }}
            cursor={{ fill: 'rgba(20, 33, 43, 0.05)' }}
          />
          <Bar
            dataKey="score"
            radius={[0, 10, 10, 0]}
            isAnimationActive
            animationDuration={750}
            animationEasing="ease-out"
          >
            {enriched.map((entry) => (
              <Cell
                key={entry.label}
                fill={entry.fill}
                stroke={entry.isTop ? '#11202b' : 'transparent'}
                strokeWidth={entry.isTop ? 1.6 : 0}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}