import path from 'node:path';
import { AasArchive } from './aasArchive.mjs';
import { resolveCompleteAas } from './aasResolver.mjs';
import { coordinateAcceptedPlugEvolution } from './evolutionCoordinator.mjs';
import { EvolutionStore } from './evolutionStore.mjs';
import { createStaticAasFileSource, CPS_LAI_STATIC_AAS_MANIFEST } from './staticAasFileSource.mjs';

function observerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function readEvolutionObserverEnabled(env = process.env) {
  const value = env.ACSM_EVOLUTION_OBSERVER_ENABLED;
  if (value == null || value === 'false') return false;
  if (value === 'true') return true;
  throw observerError('EVOLUTION_FLAG_INVALID', 'ACSM_EVOLUTION_OBSERVER_ENABLED must be exactly "true" or "false".');
}

function requireAbsolute(env, key) {
  const value = String(env[key] || '').trim();
  if (!value || !path.isAbsolute(value)) {
    throw observerError('EVOLUTION_CONFIGURATION_INVALID', `${key} must be explicitly configured as an absolute path.`);
  }
  return path.resolve(value);
}

function pathsOverlap(first, second) {
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  return contains(first, second) || contains(second, first);
}

export function createPlugEvolutionObserver({ source, archive, store, resolve = resolveCompleteAas, coordinate = coordinateAcceptedPlugEvolution } = {}) {
  if (!source || !archive || !store || typeof resolve !== 'function' || typeof coordinate !== 'function') {
    throw observerError('EVOLUTION_DEPENDENCIES_REQUIRED', 'Observer requires injected AAS source, archive, Store and coordinator dependencies.');
  }
  return Object.freeze({
    async prepare({ cpsId, expectedReference = {} } = {}) {
      const resolvedAas = await resolve({ cpsId, expectedReference, source, archive });
      return Object.freeze({ resolvedAas });
    },
    async observeAcceptedPlug({ cpsId, plugEventId, plugCycleId, prepared } = {}) {
      if (!prepared?.resolvedAas) throw observerError('EVOLUTION_AAS_NOT_PREPARED', 'Evolution AAS must be resolved before Plug mutations.');
      const report = await coordinate({
        cpsId,
        plugEventId,
        plugCycleId,
        resolvedAas: prepared.resolvedAas,
        store,
        plugAccepted: true,
      });
      return {
        ...report,
        sourceType: prepared.resolvedAas.provenance?.sourceType || 'UNKNOWN',
        operationalSource: prepared.resolvedAas.provenance?.operational === true,
        evidenceScope: prepared.resolvedAas.evidenceScope || 'STATIC_DOCUMENT_DECLARATION',
        physicalValidationInferred: false,
      };
    },
    async recordFailure({ cpsId, plugEventId, plugCycleId = null, stage, error } = {}) {
      if (typeof store.recordObserverFailure !== 'function') {
        throw observerError('EVOLUTION_FAILURE_RECORDING_UNAVAILABLE', 'Evolution Store cannot record observer failures.');
      }
      return store.recordObserverFailure({ cpsId, plugEventId, plugCycleId, stage, error });
    },
  });
}

/** No defaults: enabled observation requires an explicit static source and isolated storage paths. */
export function createConfiguredPlugEvolutionObserver(env = process.env) {
  if (!readEvolutionObserverEnabled(env)) return null;
  if (env.ACSM_EVOLUTION_AAS_SOURCE_TYPE !== 'STATIC_FILE' || env.ACSM_EVOLUTION_ALLOW_STATIC_AAS !== 'true') {
    throw observerError('EVOLUTION_STATIC_SOURCE_NOT_EXPLICIT', 'Static AAS observation requires source type STATIC_FILE and explicit ACSM_EVOLUTION_ALLOW_STATIC_AAS=true.');
  }
  if (env.NODE_ENV === 'production') {
    throw observerError('EVOLUTION_STATIC_SOURCE_PRODUCTION_DENIED', 'Static development AAS sources cannot be used in production.');
  }
  if (env.ACSM_EVOLUTION_SINGLE_PROCESS_CONFIRMED !== 'true') {
    throw observerError('EVOLUTION_CONCURRENCY_TOPOLOGY_UNCONFIRMED', 'Observer activation requires explicit confirmation that Plug requests share one process-local lifecycle lock.');
  }
  const sourceRoot = requireAbsolute(env, 'ACSM_EVOLUTION_AAS_ROOT');
  const archiveRoot = requireAbsolute(env, 'ACSM_EVOLUTION_AAS_ARCHIVE_DIR');
  const storeFile = requireAbsolute(env, 'ACSM_EVOLUTION_STORE_PATH');
  const governanceFile = path.resolve(env.GOVERNANCE_STORE_PATH || path.join(process.cwd(), 'data', 'governance-store.json'));
  const hcmFile = path.resolve(env.HCM_STORE_PATH || path.join(process.cwd(), 'data', 'hcm-store.json'));
  const protectedFiles = [governanceFile, hcmFile];
  if (protectedFiles.some((file) => pathsOverlap(archiveRoot, file) || storeFile === file) ||
      pathsOverlap(archiveRoot, storeFile) || pathsOverlap(sourceRoot, archiveRoot) || pathsOverlap(sourceRoot, storeFile)) {
    throw observerError('EVOLUTION_STORAGE_PATH_CONFLICT', 'Evolution source, archive, and Store paths must be isolated from each other, governance, and HCM storage.');
  }
  const source = createStaticAasFileSource({
    rootDir: sourceRoot,
    entries: CPS_LAI_STATIC_AAS_MANIFEST,
    sourceId: 'acsm-evolution-static-development-aas',
  });
  const archive = new AasArchive({ rootDir: archiveRoot });
  const store = new EvolutionStore({ filePath: storeFile });
  return createPlugEvolutionObserver({ source, archive, store });
}
