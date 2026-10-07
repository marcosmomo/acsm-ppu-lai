import { CPS_DISPLAY_NAME_BY_ID, getActiveAcsmConfig, normalizeCpsId } from '../acsm/config';

export const CURRENT_PLUG_PHASE_LOG_FILE = 'data/plug-phase-log.json';
export const HISTORICAL_PLUG_PHASE_LOG_FILE = 'data/plug-phase-log.history-2026-03-12.json';

const EVENT_CLASSIFICATION_BY_TYPE = [
  { test: (type) => type.includes('registered'), label: 'Registration' },
  { test: (type) => type.includes('moved_to_play') || type.includes('play'), label: 'Lifecycle Transition' },
  { test: (type) => type.includes('stop') || type.includes('stopped'), label: 'Operational Transition' },
  { test: (type) => type.includes('maintenance') || type.includes('return'), label: 'Maintenance' },
  { test: (type) => type.includes('unplug'), label: 'Unplug' },
];

export function normalizeLifecycleEventCpsId(event) {
  return normalizeCpsId(
    event?.cpsId ||
      event?.details?.lifecycleCpsId ||
      event?.details?.cpsId ||
      event?.topic ||
      event?.details?.lifecycleBaseTopic
  );
}

export function getLifecycleEventTimestamp(event) {
  const direct = Number(event?.ts);
  if (Number.isFinite(direct)) return direct;

  const parsed = Date.parse(event?.isoDate || event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyLifecycleEvent(eventType) {
  const type = String(eventType || '').toLowerCase();
  return EVENT_CLASSIFICATION_BY_TYPE.find((entry) => entry.test(type))?.label || 'Lifecycle Event';
}

function recoverCompleteEvents(raw = '') {
  const eventsKey = raw.indexOf('"events"');
  const arrayStart = raw.indexOf('[', eventsKey);
  if (eventsKey < 0 || arrayStart < 0) return [];

  const events = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < raw.length; i += 1) {
    const char = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          events.push(JSON.parse(raw.slice(objectStart, i + 1)));
        } catch {
          // Ignore incomplete trailing objects.
        }
        objectStart = -1;
      }
    }
  }

  return events;
}

export function parsePlugPhaseLogContent(raw = '') {
  try {
    return JSON.parse(raw);
  } catch {
    return { events: recoverCompleteEvents(raw) };
  }
}

export function buildCurrentExperimentLog(rawLog = {}, generatedAt = new Date()) {
  const acsmConfig = getActiveAcsmConfig();
  const managedIds = new Set((acsmConfig.managedCpsIds || []).map(normalizeCpsId));

  const events = (Array.isArray(rawLog?.events) ? rawLog.events : [])
    .map((event) => {
      const cpsId = normalizeLifecycleEventCpsId(event);
      if (!managedIds.has(cpsId)) return null;

      const ts = getLifecycleEventTimestamp(event) || generatedAt.getTime();
      return {
        ...event,
        cpsId,
        cpsName: CPS_DISPLAY_NAME_BY_ID[cpsId] || event?.cpsName || cpsId,
        topic: normalizeCpsId(event?.topic || event?.details?.lifecycleBaseTopic || cpsId),
        eventClass: classifyLifecycleEvent(event?.eventType || event?.type),
        ts,
        isoDate: new Date(ts).toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => getLifecycleEventTimestamp(a) - getLifecycleEventTimestamp(b));

  return {
    generatedAt: generatedAt.toISOString(),
    source: {
      current: CURRENT_PLUG_PHASE_LOG_FILE,
      historical: HISTORICAL_PLUG_PHASE_LOG_FILE,
      acsmId: acsmConfig.id,
      managedCpsIds: Array.from(managedIds),
    },
    events,
  };
}

export function summarizeCurrentExperimentLog(log) {
  const events = Array.isArray(log?.events) ? log.events : [];
  const cpsIds = new Set(events.map(normalizeLifecycleEventCpsId).filter(Boolean));

  return {
    cpsCount: cpsIds.size,
    eventCount: events.length,
  };
}
