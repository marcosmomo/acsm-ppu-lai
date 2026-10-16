import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function archiveError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Content-addressed byte archive. rootDir must be explicitly injected and absolute. */
export class AasArchive {
  constructor({ rootDir, fileSystem = fs, beforePublish = null } = {}) {
    if (!rootDir || !path.isAbsolute(rootDir)) {
      throw archiveError('AAS_ARCHIVE_ROOT_REQUIRED', 'AAS archive requires an explicitly injected absolute rootDir.');
    }
    this.rootDir = path.resolve(rootDir);
    this.fs = fileSystem;
    this.beforePublish = beforePublish;
  }

  _path(hash) {
    if (!HASH_PATTERN.test(String(hash || ''))) {
      throw archiveError('AAS_ARCHIVE_HASH_INVALID', 'AAS archive hash must be a lowercase SHA-256 hex digest.');
    }
    return path.join(this.rootDir, hash.slice(0, 2), `${hash}.aas`);
  }

  async archive({ bytes, expectedHash = null } = {}) {
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
      throw archiveError('AAS_ARCHIVE_BYTES_REQUIRED', 'Original AAS bytes are required.');
    }
    const original = Buffer.from(bytes);
    const contentHash = digest(original);
    if (expectedHash != null && String(expectedHash).toLowerCase() !== contentHash) {
      throw archiveError('AAS_ARCHIVE_HASH_MISMATCH', 'Original AAS bytes do not match the expected contentHash.', {
        expectedHash, actualHash: contentHash,
      });
    }
    const destination = this._path(contentHash);
    this.fs.mkdirSync(path.dirname(destination), { recursive: true });

    // Never replace an existing content-addressed object. Verify it before reuse.
    if (this.fs.existsSync(destination)) {
      const existing = this.fs.readFileSync(destination);
      if (digest(existing) !== contentHash || !existing.equals(original)) {
        throw archiveError('AAS_ARCHIVE_CONTENT_CONFLICT', 'Existing content-addressed AAS object is corrupt or divergent.', { contentHash });
      }
      return this._reference(contentHash, existing.length, true);
    }

    const temporary = path.join(path.dirname(destination), `.${contentHash}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    let descriptor;
    try {
      descriptor = this.fs.openSync(temporary, 'wx');
      this.fs.writeFileSync(descriptor, original);
      this.fs.fsyncSync(descriptor);
      this.fs.closeSync(descriptor);
      descriptor = undefined;
      if (this.beforePublish) await this.beforePublish({ temporary, destination, contentHash });
      try {
        // Hard-link publication is atomic and fails if destination already exists.
        this.fs.linkSync(temporary, destination);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = this.fs.readFileSync(destination);
        if (digest(existing) !== contentHash || !existing.equals(original)) {
          throw archiveError('AAS_ARCHIVE_CONTENT_CONFLICT', 'Concurrent content-addressed object is corrupt or divergent.', { contentHash });
        }
        return this._reference(contentHash, existing.length, true);
      }
      try {
        const directoryFd = this.fs.openSync(path.dirname(destination), 'r');
        try { this.fs.fsyncSync(directoryFd); } finally { this.fs.closeSync(directoryFd); }
      } catch {
        // Directory fsync is not supported by every platform/filesystem; file data is synced.
      }
      return this._reference(contentHash, original.length, false);
    } finally {
      if (descriptor !== undefined) this.fs.closeSync(descriptor);
      try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
    }
  }

  _reference(contentHash, byteLength, reused) {
    return Object.freeze({
      schemaVersion: '1.0',
      algorithm: 'SHA-256',
      contentHash,
      reference: `sha256:${contentHash}`,
      byteLength,
      reused,
    });
  }

  async getByHash(contentHash) {
    const filePath = this._path(String(contentHash || ''));
    let bytes;
    try { bytes = this.fs.readFileSync(filePath); }
    catch (error) {
      if (error?.code === 'ENOENT') throw archiveError('AAS_ARCHIVE_NOT_FOUND', 'No archived AAS exists for the requested hash.', { contentHash });
      throw error;
    }
    const actualHash = digest(bytes);
    if (actualHash !== contentHash) {
      throw archiveError('AAS_ARCHIVE_CORRUPT', 'Archived AAS failed SHA-256 integrity verification.', { contentHash, actualHash });
    }
    return Buffer.from(bytes);
  }
}

export function createAasArchive(options) {
  return new AasArchive(options);
}
