import { validateMessage, PPU_TOPIC } from '../../services/cps-lai-01-persistence/src/contracts.js';

export const PPU_OUTBOX_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const iso = (value = new Date()) => (value instanceof Date ? value : new Date(value)).toISOString();

export function sanitizeOutboxError(error) {
  const code = String(error?.code || 'PPU_OUTBOX_ERROR').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64);
  const message = String(error?.message || error || 'Unknown outbox error')
    .replace(/\b(password|passwd|token|secret|api[-_]?key|username)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, 300);
  return { code: code || 'PPU_OUTBOX_ERROR', message };
}

export function normalizePpuOutbox(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function enqueuePpuOutbox(store, event, { now = new Date() } = {}) {
  const validation = validateMessage(PPU_TOPIC, event, 'cpslai1');
  if (!validation.ok) {
    const error = new Error(`Invalid PPU outbox event: ${validation.errors.join(',')}`);
    error.code = 'INVALID_PPU_EVENT';
    throw error;
  }
  store.ppuOutbox = normalizePpuOutbox(store.ppuOutbox);
  const existing = store.ppuOutbox[event.eventId];
  if (existing) {
    if (JSON.stringify(existing.payload) !== JSON.stringify(event)) {
      const error = new Error('An outbox event with this eventId already has a different payload.');
      error.code = 'PPU_OUTBOX_EVENT_CONFLICT';
      throw error;
    }
    return { entry: clone(existing), duplicate: true };
  }
  const timestamp = iso(now);
  const entry = {
    eventId: event.eventId,
    topic: PPU_TOPIC,
    payload: clone(event),
    status: PPU_OUTBOX_STATUS.PENDING,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAttemptAt: null,
    nextAttemptAt: null,
    publishedAt: null,
    lastError: null,
  };
  store.ppuOutbox[event.eventId] = entry;
  return { entry: clone(entry), duplicate: false };
}

export function markPpuOutboxPublished(store, eventId, { now = new Date() } = {}) {
  const entry = store.ppuOutbox?.[eventId];
  if (!entry) throw Object.assign(new Error('PPU outbox event not found.'), { code: 'PPU_OUTBOX_NOT_FOUND' });
  const timestamp = iso(now);
  Object.assign(entry, {
    status: PPU_OUTBOX_STATUS.PUBLISHED,
    attempts: Number(entry.attempts || 0) + 1,
    lastAttemptAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: null,
    publishedAt: timestamp,
    lastError: null,
  });
  return clone(entry);
}

export function markPpuOutboxFailed(store, eventId, error, { now = new Date(), retryDelayMs = 30_000 } = {}) {
  const entry = store.ppuOutbox?.[eventId];
  if (!entry) throw Object.assign(new Error('PPU outbox event not found.'), { code: 'PPU_OUTBOX_NOT_FOUND' });
  const instant = now instanceof Date ? now : new Date(now);
  const timestamp = instant.toISOString();
  Object.assign(entry, {
    status: PPU_OUTBOX_STATUS.FAILED,
    attempts: Number(entry.attempts || 0) + 1,
    lastAttemptAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: new Date(instant.getTime() + Math.max(0, retryDelayMs)).toISOString(),
    lastError: sanitizeOutboxError(error),
  });
  return clone(entry);
}

export function isPpuOutboxEntryDue(entry, { now = new Date(), maxAttempts = 5 } = {}) {
  if (!entry || entry.status === PPU_OUTBOX_STATUS.PUBLISHED) return false;
  if (Number(entry.attempts || 0) >= maxAttempts) return false;
  return !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= new Date(now).getTime();
}
