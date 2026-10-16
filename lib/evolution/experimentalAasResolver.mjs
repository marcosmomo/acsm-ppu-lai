import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from './experimentalAasCatalog.mjs';

export const EXPERIMENTAL_AAS_RESOLVER_VERSION = 'experimental-aas-resolver/1.0.0';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalizeCpsId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+1$/, 'cpslai1');
const normalizeVersion = (value) => String(value || '').trim().toLowerCase();

function resolverError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
function confined(root, candidate, code = 'EXPERIMENTAL_AAS_PATH_INVALID') {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw resolverError(code, 'Experimental AAS path must remain inside the configured root.');
  }
  return relative.replaceAll('\\', '/');
}

function validateLocator(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw resolverError('EXPERIMENTAL_AAS_PATH_INVALID', 'Catalog locator must be a relative path.');
  }
  const resolved = path.resolve(root, relativePath);
  return { resolved, relative: confined(root, resolved) };
}

function parseDocument(rawBytes, locator) {
  try { return JSON.parse(rawBytes.toString('utf8')); }
  catch (error) {
    throw resolverError('EXPERIMENTAL_AAS_MALFORMED', 'Experimental AAS is not valid JSON.', {
      locator, cause: error?.message || String(error),
    });
  }
}

export function createExperimentalAasResolver({
  rootDir,
  catalog = CPSLAI1_EXPERIMENTAL_AAS_CATALOG,
  fileSystem = fs,
  sourceId = 'cpslai1-avm-experimental-catalog',
} = {}) {
  if (!rootDir || !path.isAbsolute(rootDir)) {
    throw resolverError('EXPERIMENTAL_AAS_ROOT_REQUIRED', 'Resolver requires an explicitly injected absolute rootDir.');
  }
  const root = path.resolve(rootDir);

  return Object.freeze({
    resolverVersion: EXPERIMENTAL_AAS_RESOLVER_VERSION,
    sourceId,
    sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT',
    operational: false,
    async resolve({ cpsId, aasVersion } = {}) {
      const normalizedCpsId = normalizeCpsId(cpsId);
      if (normalizedCpsId !== 'cpslai1') {
        throw resolverError('EXPERIMENTAL_AAS_CPS_NOT_ALLOWED', 'Experimental catalog accepts only cpslai1.');
      }
      const version = normalizeVersion(aasVersion);
      const cpsEntry = catalog?.cps?.cpslai1;
      const entry = cpsEntry?.versions?.[version];
      if (!entry) {
        throw resolverError('EXPERIMENTAL_AAS_VERSION_NOT_ALLOWED', 'Requested AAS version is not in the experimental allowlist.', {
          aasVersion: version || null,
        });
      }
      const location = validateLocator(root, entry.relativePath);
      let rootReal;
      let fileReal;
      try {
        rootReal = fileSystem.realpathSync(root);
        fileReal = fileSystem.realpathSync(location.resolved);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw resolverError('EXPERIMENTAL_AAS_NOT_FOUND', 'Allowlisted experimental AAS file does not exist.', {
            locator: location.relative,
          });
        }
        throw error;
      }
      confined(rootReal, fileReal, 'EXPERIMENTAL_AAS_SYMLINK_ESCAPE');
      const rawBytes = fileSystem.readFileSync(fileReal);
      const contentHash = sha256(rawBytes);
      if (contentHash !== String(entry.sha256 || '').toLowerCase()) {
        throw resolverError('EXPERIMENTAL_AAS_HASH_MISMATCH', 'Experimental AAS bytes do not match the catalog hash.', {
          version, expected: entry.sha256, actual: contentHash,
        });
      }
      const document = parseDocument(rawBytes, location.relative);
      const shells = document?.assetAdministrationShells;
      if (!Array.isArray(shells) || shells.length !== 1) {
        throw resolverError('EXPERIMENTAL_AAS_IDENTITY_INVALID', 'Experimental AAS must contain exactly one shell.');
      }
      const aasId = shells[0]?.id || null;
      const assetId = shells[0]?.assetInformation?.globalAssetId || null;
      if (aasId !== entry.aasId || assetId !== entry.assetId) {
        throw resolverError('EXPERIMENTAL_AAS_IDENTITY_MISMATCH', 'Experimental AAS identity differs from the allowlisted identity.', {
          expected: { aasId: entry.aasId, assetId: entry.assetId }, actual: { aasId, assetId },
        });
      }
      return {
        schemaVersion: '1.0',
        resolverVersion: EXPERIMENTAL_AAS_RESOLVER_VERSION,
        document,
        rawBytes: Buffer.from(rawBytes),
        identity: { cpsId: normalizedCpsId, aasId, assetId },
        integrity: { algorithm: 'SHA-256', contentHash },
        provenance: {
          sourceId, sourceType: entry.sourceClassification, operational: false,
          locator: location.relative, aasVersion: version, description: entry.description,
        },
        catalogEntry: { ...entry },
        physicalStateInferred: false,
      };
    },
  });
}
