import { normalizeMessage } from './normalize.js';
import { validateMessage } from './contracts.js';
import { PPU_TOPIC } from './contracts.js';
import { createHash } from 'node:crypto';

export class IngestionService {
  constructor({ spool, repository, cpsId = 'cpslai1', maxEvidenceAgeMs = 15000, now = () => new Date() }) {
    this.spool = spool;
    this.repository = repository;
    this.cpsId = cpsId;
    this.maxEvidenceAgeMs = maxEvidenceAgeMs;
    this.now = now;
    this.lastError = null;
    this.processing = false;
  }

  async accept({ topic, payload, qos = 1, retain = false }) {
    const receivedAt = this.now();
    const validation = topic === PPU_TOPIC && retain
      ? { ok: false, errors: ['retained_ppu_event_forbidden'] }
      : validateMessage(topic, payload, this.cpsId);
    if (!validation.ok) {
      const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
      let dedupeKey = createHash('sha256').update(`${this.cpsId}\n${topic}\n${String(raw)}`).digest('hex');
      try { dedupeKey = normalizeMessage({ topic, payload: JSON.parse(raw), receivedAt, cpsId: this.cpsId }).record.dedupeKey; } catch { /* invalid JSON is still quarantined */ }
      await this.spool.reject({ topic, payload: raw, receivedAt: receivedAt.toISOString(), dedupeKey }, validation.errors);
      return { accepted: false, errors: validation.errors };
    }
    const normalized = normalizeMessage({ topic, payload, receivedAt, cpsId: this.cpsId, qos, retain, maxEvidenceAgeMs: this.maxEvidenceAgeMs });
    const envelope = {
      topic,
      payload: normalized.record.rawPayloadText,
      receivedAt: receivedAt.toISOString(),
      qos,
      retain,
      dedupeKey: normalized.record.dedupeKey,
    };
    const queued = await this.spool.enqueue(envelope);
    void this.drain();
    return { accepted: true, duplicateInSpool: queued.duplicate, dedupeKey: envelope.dedupeKey };
  }

  async drain() {
    if (this.processing) return this.currentDrain;
    this.processing = true;
    this.currentDrain = (async () => {
      const entries = await this.spool.load();
      for (const entry of entries) {
        try {
          const normalized = normalizeMessage({ ...entry, cpsId: this.cpsId, maxEvidenceAgeMs: this.maxEvidenceAgeMs });
          await this.repository.persist(normalized);
          await this.spool.acknowledge(entry.dedupeKey);
          this.lastError = null;
        } catch (error) {
          this.lastError = error.code ?? 'persistence_failed';
          break;
        }
      }
    })();
    const current = this.currentDrain;
    try { await current; }
    finally { this.processing = false; this.currentDrain = null; }
  }

  health() {
    return { ready: !this.lastError, pending: this.spool.size(), databaseError: this.lastError };
  }
}
