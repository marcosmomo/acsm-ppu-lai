import fs from 'node:fs';
import path from 'node:path';

const normalizeCpsId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+([123])$/, 'cpslai$1');

function sourceError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function confinedPath(rootDir, relativeFile) {
  if (!relativeFile || path.isAbsolute(relativeFile)) {
    throw sourceError('AAS_SOURCE_PATH_INVALID', 'Static AAS locator must be a relative file path.');
  }
  const resolved = path.resolve(rootDir, relativeFile);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw sourceError('AAS_SOURCE_PATH_INVALID', 'Static AAS locator must remain inside the configured root.');
  }
  return { resolved, relative: relative.replaceAll('\\', '/') };
}

function selectLocator(entry, expectedReference) {
  const requestedRevision = String(expectedReference?.sourceRevision || '').trim();
  if (requestedRevision) {
    const locator = entry?.versions?.[requestedRevision];
    if (!locator) {
      throw sourceError('AAS_SOURCE_REVISION_NOT_FOUND', 'Requested static AAS source revision is not configured.', {
        sourceRevision: requestedRevision,
      });
    }
    return { locator, sourceRevision: requestedRevision };
  }
  const locator = typeof entry === 'string' ? entry : entry?.file;
  if (!locator) throw sourceError('AAS_SOURCE_DOCUMENT_NOT_FOUND', 'No default static AAS document is configured for this CPS.');
  return { locator, sourceRevision: String(entry?.revision || 'default') };
}

export function createStaticAasFileSource({ rootDir, entries, fileSystem = fs, sourceId = 'cps-defs-static' } = {}) {
  if (!rootDir || !path.isAbsolute(rootDir)) {
    throw sourceError('AAS_SOURCE_ROOT_REQUIRED', 'Static AAS source requires an absolute rootDir.');
  }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw sourceError('AAS_SOURCE_MANIFEST_REQUIRED', 'Static AAS source requires an explicit CPS manifest.');
  }
  const root = path.resolve(rootDir);
  const manifest = Object.fromEntries(Object.entries(entries).map(([key, value]) => [normalizeCpsId(key), value]));

  return Object.freeze({
    sourceId,
    sourceType: 'STATIC_FILE',
    operational: false,
    async resolve({ cpsId, expectedReference = {} } = {}) {
      const normalizedCpsId = normalizeCpsId(cpsId);
      const entry = manifest[normalizedCpsId];
      if (!entry) throw sourceError('AAS_SOURCE_CPS_NOT_CONFIGURED', 'CPS is not configured in the static AAS source.');
      const selected = selectLocator(entry, expectedReference);
      const location = confinedPath(root, selected.locator);
      let rawBytes;
      try {
        rawBytes = fileSystem.readFileSync(location.resolved);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw sourceError('AAS_SOURCE_DOCUMENT_NOT_FOUND', 'Configured static AAS document does not exist.', {
            locator: location.relative,
          });
        }
        throw error;
      }
      let document;
      try {
        document = JSON.parse(rawBytes.toString('utf8'));
      } catch (error) {
        throw sourceError('AAS_SOURCE_DOCUMENT_MALFORMED', 'Configured static AAS document is not valid JSON.', {
          locator: location.relative,
          cause: error?.message || String(error),
        });
      }
      return {
        document,
        rawBytes,
        provenance: {
          sourceId,
          sourceType: 'STATIC_FILE',
          operational: false,
          locator: location.relative,
          sourceRevision: selected.sourceRevision,
        },
      };
    },
  });
}

export const CPS_LAI_STATIC_AAS_MANIFEST = Object.freeze({
  cpslai1: Object.freeze({ file: 'cps-lai-01-aas-acsm-compatible-revised.json', revision: 'repository-current' }),
  cpslai2: Object.freeze({ file: 'cps-lai-02-aas-acsm-compatible-revised.json', revision: 'repository-current' }),
  cpslai3: Object.freeze({ file: 'cps-lai-03-aas-acsm-compatible-revised.json', revision: 'repository-current' }),
});
