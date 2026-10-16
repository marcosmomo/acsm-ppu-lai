import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PLUG_CYCLE_STATES = Object.freeze({
  RESERVED: 'RESERVED', ACTIVE: 'ACTIVE', CLOSED: 'CLOSED', FAILED: 'FAILED',
});

const BLOCKING_STATES = new Set(['RESERVED', 'ACTIVE', 'FAILED']);
const EMPTY_STORE = Object.freeze({ schemaVersion: 1, revision: 0, cycles: [] });

function reservationError(code, message, details = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw reservationError('PLUG_RESERVATION_INVALID_INPUT', `${name} is required.`, { field: name });
  return normalized;
}

function normalizeCpsId(value) {
  const cleaned = required(value, 'cpsId').toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = cleaned.match(/^([a-z]+)0*([0-9]+)$/);
  return match ? `${match[1]}${match[2]}` : cleaned;
}

function canonicalIdentity(identity) {
  if (identity === undefined || identity === null) return null;
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(identity))).digest('hex');
}

function clone(value) { return structuredClone(value); }

/**
 * Isolated proof-of-concept repository. It is deliberately not imported by the
 * operational Plug route or governance store.
 *
 * Multiprocess exclusion uses atomic directory creation. A left-over lock is
 * never removed based on age: an operator/reconciler must verify reality and
 * explicitly call releaseOrphanedLock(). This assumption is valid only when all
 * writers share a local filesystem with atomic mkdir/rename semantics.
 */
export class PlugCycleReservationStore {
  constructor({ filePath, now = () => new Date().toISOString(), lockTimeoutMs = 5000, retryMs = 10, faultInjector = null } = {}) {
    if (!filePath) throw reservationError('PLUG_RESERVATION_PATH_REQUIRED', 'An isolated filePath is required.');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.retryMs = retryMs;
    this.faultInjector = faultInjector;
  }

  read() { return clone(this.#readUnsafe()); }

  reserve({ cpsId, plugEventId, identity = null, metadata = null } = {}) {
    const cpsKey = normalizeCpsId(cpsId);
    const eventId = required(plugEventId, 'plugEventId');
    const identityHash = canonicalIdentity(identity);
    return this.#transaction((store) => {
      const sameEvent = store.cycles.find((cycle) => cycle.plugEventId === eventId);
      if (sameEvent) {
        if (sameEvent.cpsId !== cpsKey || (identityHash && sameEvent.identityHash && sameEvent.identityHash !== identityHash)) {
          throw reservationError('PLUG_EVENT_IDENTITY_CONFLICT', 'plugEventId is already bound to another identity.', {
            plugEventId: eventId, requestedCpsId: cpsKey, boundCpsId: sameEvent.cpsId,
          });
        }
        return { changed: false, value: { reservation: sameEvent, created: false, idempotent: true } };
      }
      const blocking = store.cycles.find((cycle) => cycle.cpsId === cpsKey && BLOCKING_STATES.has(cycle.state));
      if (blocking) {
        throw reservationError('PLUG_CYCLE_CONFLICT', 'CPS already has a reservation or non-closed cycle.', {
          cpsId: cpsKey, activePlugEventId: blocking.plugEventId, activePlugCycleId: blocking.plugCycleId, state: blocking.state,
        });
      }
      const at = this.now();
      const reservation = {
        cpsId: cpsKey,
        plugEventId: eventId,
        plugCycleId: `${cpsKey}-cycle-${crypto.randomUUID()}`,
        identityHash,
        state: PLUG_CYCLE_STATES.RESERVED,
        reservedAt: at,
        activatedAt: null,
        closedAt: null,
        failedAt: null,
        failure: null,
        closeEvidence: null,
        metadata: metadata === null ? null : clone(metadata),
      };
      store.cycles.push(reservation);
      return { changed: true, value: { reservation, created: true, idempotent: false } };
    });
  }

  activate({ cpsId, plugEventId, plugCycleId, governanceProfileId = null, governanceProfileVersion = null } = {}) {
    return this.#transition({ cpsId, plugEventId, plugCycleId }, (cycle) => {
      if (cycle.state === 'ACTIVE') return false;
      if (cycle.state !== 'RESERVED') throw reservationError('PLUG_CYCLE_INVALID_STATE', 'Only RESERVED cycles can become ACTIVE.', { state: cycle.state });
      cycle.state = 'ACTIVE';
      cycle.activatedAt = this.now();
      cycle.governanceProfileId = governanceProfileId;
      cycle.governanceProfileVersion = governanceProfileVersion;
      return true;
    });
  }

  recordFailure({ cpsId, plugEventId, plugCycleId, stage, error } = {}) {
    return this.#transition({ cpsId, plugEventId, plugCycleId }, (cycle) => {
      if (cycle.state === 'CLOSED') throw reservationError('PLUG_CYCLE_INVALID_STATE', 'A closed cycle cannot fail.', { state: cycle.state });
      const at = this.now();
      cycle.state = 'FAILED';
      cycle.failedAt = at;
      cycle.failure = { stage: required(stage, 'stage'), code: String(error?.code || 'PLUG_PARTIAL_FAILURE'), message: String(error?.message || error || 'Partial Plug failure').slice(0, 500), recordedAt: at };
      return true;
    });
  }

  close({ cpsId, plugEventId, plugCycleId, evidence } = {}) {
    if (!evidence || typeof evidence !== 'object') throw reservationError('PLUG_CLOSE_EVIDENCE_REQUIRED', 'Verified Unplug evidence is required.');
    return this.#transition({ cpsId, plugEventId, plugCycleId }, (cycle) => {
      if (cycle.state === 'CLOSED') return false;
      cycle.state = 'CLOSED';
      cycle.closedAt = this.now();
      cycle.closeEvidence = clone(evidence);
      return true;
    });
  }

  #transition(ids, mutate) {
    const cpsKey = normalizeCpsId(ids.cpsId);
    const eventId = required(ids.plugEventId, 'plugEventId');
    const cycleId = required(ids.plugCycleId, 'plugCycleId');
    return this.#transaction((store) => {
      const cycle = store.cycles.find((item) => item.plugCycleId === cycleId);
      if (!cycle) throw reservationError('PLUG_CYCLE_NOT_FOUND', 'Plug cycle was not found.', { plugCycleId: cycleId });
      if (cycle.cpsId !== cpsKey || cycle.plugEventId !== eventId) throw reservationError('PLUG_CYCLE_IDENTITY_CONFLICT', 'Cycle, CPS and event identifiers do not match.', { plugCycleId: cycleId });
      const changed = mutate(cycle);
      return { changed, value: { reservation: cycle, changed } };
    });
  }

  inspectLock() {
    try { return JSON.parse(fs.readFileSync(path.join(this.lockPath, 'owner.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw reservationError('PLUG_LOCK_INSPECTION_FAILED', 'Could not inspect reservation lock.', {}, error); }
  }

  releaseOrphanedLock({ verified, reason } = {}) {
    if (verified !== true || !String(reason || '').trim()) throw reservationError('PLUG_LOCK_VERIFICATION_REQUIRED', 'Explicit verification and reason are required.');
    const owner = this.inspectLock();
    if (!owner) return { released: false, owner: null };
    fs.rmSync(this.lockPath, { recursive: true, force: false });
    return { released: true, owner, reason: String(reason) };
  }

  #acquireLock() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        fs.writeFileSync(path.join(this.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: this.now() }));
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw reservationError('PLUG_LOCK_ACQUIRE_FAILED', 'Could not acquire reservation lock.', {}, error);
        if (Date.now() >= deadline) throw reservationError('PLUG_RESERVATION_BUSY', 'Reservation store is locked; lock was not removed automatically.', { owner: this.inspectLock() });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.retryMs);
      }
    }
  }

  #releaseLock() {
    fs.rmSync(this.lockPath, { recursive: true, force: false });
  }

  #transaction(operation) {
    this.#acquireLock();
    try {
      const store = this.#readUnsafe();
      const result = operation(store);
      if (result.changed) this.#writeUnsafe({ ...store, revision: store.revision + 1 });
      return clone(result.value);
    } finally {
      this.#releaseLock();
    }
  }

  #readUnsafe() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.cycles)) throw new Error('Unsupported reservation schema.');
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return clone(EMPTY_STORE);
      throw reservationError('PLUG_RESERVATION_READ_FAILED', 'Reservation data is unreadable; refusing to assume an empty store.', {}, error);
    }
  }

  #writeUnsafe(store) {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.faultInjector?.('beforeRename', { temporary, filePath: this.filePath });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best-effort removal of this transaction's temp file */ }
      throw reservationError('PLUG_RESERVATION_WRITE_FAILED', 'Reservation persistence failed.', {}, error);
    }
  }
}
