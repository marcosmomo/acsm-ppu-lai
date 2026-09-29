'use client';

import React, { useMemo } from 'react';

const STATE_TONES = [
  { match: 'low_response', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.14)' },
  { match: 'persistent_critical', color: '#f97316', bg: 'rgba(249, 115, 22, 0.15)' },
  { match: 'persistent_local_loss', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.16)' },
  { match: 'chronic_loss', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.16)' },
  { match: 'degrading', color: '#eab308', bg: 'rgba(234, 179, 8, 0.16)' },
  { match: 'recovering', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)' },
  { match: 'stable', color: '#64748b', bg: 'rgba(100, 116, 139, 0.14)' },
];

function toneForState(state) {
  const normalized = String(state || '').toLowerCase();
  return STATE_TONES.find((tone) => normalized.includes(tone.match)) || {
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.14)',
  };
}

function getEventDate(item) {
  const raw = item?.timestamp || item?.ts;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function formatTime(date) {
  if (!date) return '--:--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds()
  ).padStart(2, '0')}`;
}

function formatInterval(group) {
  if (group.count <= 1) return formatTime(group.firstDate);
  const minDate = group.dates.reduce((oldest, date) => (date < oldest ? date : oldest), group.dates[0]);
  const maxDate = group.dates.reduce((newest, date) => (date > newest ? date : newest), group.dates[0]);
  return `${formatTime(minDate)}-${formatTime(maxDate)}`;
}

function buildGroups(items, maxItems) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      ...item,
      _date: getEventDate(item),
      _index: index,
      temporalState: item?.temporalState || 'unknown_state',
      adaptiveAction: item?.adaptiveAction || 'no_action',
    }))
    .sort((a, b) => {
      const aTime = a._date ? a._date.getTime() : 0;
      const bTime = b._date ? b._date.getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, maxItems);

  return normalized.reduce((groups, item) => {
    const previous = groups[groups.length - 1];
    const sameAsPrevious =
      previous && previous.temporalState === item.temporalState && previous.adaptiveAction === item.adaptiveAction;

    if (sameAsPrevious) {
      previous.items.push(item);
      previous.dates.push(item._date || previous.firstDate);
      previous.count += 1;
      return groups;
    }

    groups.push({
      temporalState: item.temporalState,
      adaptiveAction: item.adaptiveAction,
      strategyClass: item?.strategyClass || '',
      interventionEffectiveness: item?.interventionEffectiveness || '',
      firstDate: item._date,
      dates: [item._date],
      items: [item],
      count: 1,
    });
    return groups;
  }, []);
}

export default function AdaptiveTimeline({
  title = 'Adaptive Timeline',
  items = [],
  variant = 'light',
  emptyText = 'No adaptive history yet.',
  maxItems = 8,
}) {
  const groups = useMemo(() => buildGroups(items, maxItems), [items, maxItems]);
  const isDark = variant === 'dark';
  const text = isDark ? '#e2e8f0' : '#0f172a';
  const muted = isDark ? '#94a3b8' : '#64748b';
  const border = isDark ? 'rgba(255,255,255,0.10)' : '#e2e8f0';
  const rowBg = isDark ? 'rgba(15,23,42,0.34)' : '#f8fafc';

  if (!groups.length) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 12, color: text, fontWeight: 900 }}>{title}</div>
        <div style={{ color: muted, fontSize: 12 }}>{emptyText}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 12, color: text, fontWeight: 900 }}>{title}</div>
        <div style={{ fontSize: 10, color: muted, fontWeight: 800 }}>{groups.length} groups</div>
      </div>

      <div style={{ display: 'flex', gap: 3, alignItems: 'stretch', height: 12 }}>
        {groups.map((group, index) => {
          const tone = toneForState(group.temporalState);
          const titleText = `${formatInterval(group)} | ${group.temporalState} | ${group.adaptiveAction}${
            group.count > 1 ? ` | x${group.count}` : ''
          }`;
          return (
            <div
              key={`${group.temporalState}-${group.adaptiveAction}-${index}`}
              title={titleText}
              style={{
                flex: Math.max(group.count, 1),
                minWidth: 14,
                borderRadius: 4,
                background: tone.color,
                boxShadow: isDark ? '0 0 0 1px rgba(255,255,255,0.08) inset' : '0 0 0 1px rgba(15,23,42,0.08) inset',
              }}
            />
          );
        })}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {groups.map((group, index) => {
          const tone = toneForState(group.temporalState);
          return (
            <div
              key={`${group.temporalState}-${group.adaptiveAction}-${index}-row`}
              style={{
                display: 'grid',
                gridTemplateColumns: '102px minmax(0, 1fr) auto',
                gap: 8,
                alignItems: 'center',
                padding: '7px 8px',
                border: `1px solid ${border}`,
                borderRadius: 8,
                background: rowBg,
                fontSize: 11,
                minWidth: 0,
              }}
            >
              <span style={{ color: muted, fontWeight: 900, whiteSpace: 'nowrap' }}>{formatInterval(group)}</span>
              <span style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: text,
                    fontWeight: 900,
                    minWidth: 0,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.color, flex: '0 0 auto' }} />
                  <span style={{ overflowWrap: 'anywhere' }}>{group.temporalState}</span>
                </span>
                <span style={{ color: muted, overflowWrap: 'anywhere' }}>| {group.adaptiveAction}</span>
                {group.strategyClass ? (
                  <span
                    style={{
                      color: tone.color,
                      background: tone.bg,
                      borderRadius: 999,
                      padding: '2px 6px',
                      fontWeight: 900,
                    }}
                  >
                    {group.strategyClass}
                  </span>
                ) : null}
              </span>
              {group.count > 1 ? (
                <span
                  style={{
                    color: tone.color,
                    background: tone.bg,
                    borderRadius: 999,
                    padding: '2px 6px',
                    fontWeight: 900,
                    whiteSpace: 'nowrap',
                  }}
                >
                  x{group.count}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
