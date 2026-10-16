const normalizeCpsId = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1');
const PLUG_LOCKS = Symbol.for('acsm.explicit-plug.request-locks');
globalThis[PLUG_LOCKS] ||= new Map();

function withCpsPlugLock(cpsId, task) {
  const locks = globalThis[PLUG_LOCKS];
  const key = normalizeCpsId(cpsId);
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.then(task, task);
  const marker = current.then(() => undefined, () => undefined);
  locks.set(key, marker);
  marker.then(() => { if (locks.get(key) === marker) locks.delete(key); });
  return current;
}

function failureResult(stage, error) {
  return {
    status: 'FAILED',
    stage,
    error: {
      code: String(error?.code || 'EVOLUTION_OBSERVER_FAILED').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64),
      message: String(error?.message || 'Evolution observation failed.').slice(0, 300),
    },
    comparisonCompleted: false,
  };
}

function findAsset(state, cpsId) {
  const key = normalizeCpsId(cpsId);
  return (state?.assets || []).find((item) =>
    [item?.cps?.cpsId, item?.cps?.id, item?.interfaces?.baseTopic]
      .some((value) => normalizeCpsId(value) === key));
}

/** Injectable request handler for isolated route tests; production dependencies are supplied by the Next route. */
export function createPlugPostHandler(dependencies = {}) {
  const {
    jsonResponse,
    getPlugState,
    transitionPlugAssetLifecycle,
    updatePlugSnapshot,
    executeAcsmUnplug,
    closeGovernancePlugCycle,
    createGovernanceProfileForPlug,
    enqueuePpuOutboxEvent,
    buildPlugRequestedPpuEvent,
    sanitizeOutboxError,
    getEvolutionObserver = () => null,
    isEvolutionRequested = () => false,
    getActiveGovernanceProfile = () => null,
    logger = console,
  } = dependencies;
  const required = [jsonResponse, getPlugState, transitionPlugAssetLifecycle, updatePlugSnapshot,
    executeAcsmUnplug, closeGovernancePlugCycle, createGovernanceProfileForPlug,
    enqueuePpuOutboxEvent, buildPlugRequestedPpuEvent, sanitizeOutboxError];
  if (required.some((dependency) => typeof dependency !== 'function')) {
    throw new TypeError('Plug POST handler dependencies are incomplete.');
  }

  return async function handlePlugPost(request) {
    try {
      const snapshot = await request.json();
      if (snapshot?.lifecycleTransition?.phase) {
        const { cpsId, phase, timestamp, plugEventId } = snapshot.lifecycleTransition;
        const normalizedPhase = String(phase).toLowerCase();
        if (normalizedPhase === 'plug') {
          if (!cpsId || !plugEventId) {
            return jsonResponse({ error: 'cpsId and plugEventId are required for Plug.' }, { status: 400 });
          }

          const processPlug = async () => {

          // Observer setup and AAS resolution happen before registration/governance/lifecycle writes.
          // All errors are observational and do not block the pre-existing Plug path.
          let evolutionObserver = null;
          let preparedEvolution = null;
          let evolutionFailure = null;
          let observerRequested = false;
          try {
            observerRequested = isEvolutionRequested() === true;
            evolutionObserver = getEvolutionObserver();
            observerRequested ||= Boolean(evolutionObserver);
            if (observerRequested) {
              const activeProfile = getActiveGovernanceProfile(cpsId);
              if (activeProfile?.plugCycleStatus === 'ACTIVE' && activeProfile.plugEventId !== plugEventId) {
                return jsonResponse({
                  ok: false,
                  cpsId,
                  reason: 'ACTIVE_PLUG_CYCLE_CONFLICT',
                  activePlugEventId: activeProfile.plugEventId || null,
                }, { status: 409 });
              }
            }
            if (evolutionObserver) {
              const stateBeforeMutation = getPlugState();
              const candidate = findAsset(stateBeforeMutation, cpsId) ||
                (findAsset({ assets: [snapshot.asset] }, cpsId) ? snapshot.asset : null);
              if (!candidate?.aas?.id) {
                throw Object.assign(new Error('AAS identity is unavailable before Plug mutations.'), { code: 'EVOLUTION_AAS_IDENTITY_MISSING' });
              }
              preparedEvolution = await evolutionObserver.prepare({
                cpsId,
                expectedReference: { aasId: candidate.aas.id },
              });
            }
          } catch (error) {
            try { observerRequested ||= isEvolutionRequested() === true || error?.code === 'EVOLUTION_FLAG_INVALID'; } catch { /* request remains observationally disabled */ }
            evolutionFailure = failureResult(error?.code === 'EVOLUTION_CONFIGURATION_INVALID' || error?.code?.startsWith?.('EVOLUTION_STATIC') || error?.code === 'EVOLUTION_FLAG_INVALID'
              ? 'CONFIGURATION' : 'RESOLUTION', error);
          }
          if (observerRequested && !evolutionObserver) {
            const activeProfile = getActiveGovernanceProfile(cpsId);
            if (activeProfile?.plugCycleStatus === 'ACTIVE' && activeProfile.plugEventId !== plugEventId) {
              return jsonResponse({ ok: false, cpsId, reason: 'ACTIVE_PLUG_CYCLE_CONFLICT', activePlugEventId: activeProfile.plugEventId || null }, { status: 409 });
            }
          }

          let current = getPlugState();
          let asset = findAsset(current, cpsId);
          if (!asset && snapshot.asset?.aas?.id) {
            current = updatePlugSnapshot({ assets: [...current.assets, snapshot.asset] });
            asset = findAsset(current, cpsId);
          }
          if (!asset?.aas?.id) {
            return jsonResponse({ ok: false, cpsId, reason: 'CPS_NOT_REGISTERED_OR_AAS_MISSING' }, { status: 404 });
          }
          const previousState = asset?.cps?.lifecyclePhase || asset?.cps?.lifecycle?.currentPhase || null;

          const governance = createGovernanceProfileForPlug(cpsId, asset.cps || { id: cpsId }, { plugEventId });
          if (!governance.activeProfile || governance.activeProfile.status !== 'PENDING_APPROVAL') {
            return jsonResponse({ ok: false, cpsId, reason: 'ACTIVE_PENDING_PROFILE_NOT_CREATED' }, { status: 409 });
          }
          const transition = transitionPlugAssetLifecycle(cpsId, 'plug', timestamp);
          if (!transition.ok) {
            return jsonResponse({ ok: false, cpsId, reason: transition.reason }, { status: 404 });
          }
          const ppuEvent = normalizeCpsId(cpsId) === 'cpslai1'
            ? buildPlugRequestedPpuEvent({
                cpsId,
                plugEventId,
                plugCycleId: governance.activeProfile.plugCycleId,
                occurredAt: governance.activeProfile.plugStartedAt,
                previousState,
                profile: governance.activeProfile,
                aasId: asset?.aas?.id || null,
              })
            : null;
          let ppuOutbox = null;
          if (ppuEvent) {
            try { ppuOutbox = enqueuePpuOutboxEvent(ppuEvent); }
            catch (error) {
              const failure = sanitizeOutboxError(error);
              logger.error?.('[PPU_OUTBOX_PREPARATION_FAILED]', failure);
              ppuOutbox = { stored: false, error: failure };
            }
          }

          let evolution;
          if (evolutionObserver) {
            if (!evolutionFailure && preparedEvolution) {
              try {
                evolution = await evolutionObserver.observeAcceptedPlug({
                  cpsId,
                  plugEventId,
                  plugCycleId: governance.activeProfile.plugCycleId,
                  prepared: preparedEvolution,
                });
              } catch (error) {
                evolutionFailure = failureResult('CAPTURE', error);
              }
            }
            if (evolutionFailure) {
              evolution = evolutionFailure;
              try {
                await evolutionObserver.recordFailure?.({
                  cpsId,
                  plugEventId,
                  plugCycleId: governance.activeProfile.plugCycleId,
                  stage: evolutionFailure.stage,
                  error: Object.assign(new Error(evolutionFailure.error.message), { code: evolutionFailure.error.code }),
                });
              } catch (recordError) {
                logger.error?.('[EVOLUTION_FAILURE_RECORDING_FAILED]', {
                  code: recordError?.code || 'EVOLUTION_FAILURE_RECORDING_FAILED',
                  message: String(recordError?.message || recordError).slice(0, 300),
                });
              }
            }
            if (evolution?.status === 'FAILED') logger.warn?.('[EVOLUTION_OBSERVER_FAILED]', evolution);
          } else if (evolutionFailure && observerRequested) {
            evolution = evolutionFailure;
            logger.warn?.('[EVOLUTION_OBSERVER_CONFIGURATION_FAILED]', evolution);
          }

          return jsonResponse({
            ok: true,
            cpsId,
            lifecyclePhase: 'plug',
            activeProfile: governance.activeProfile,
            ppuEvent,
            ppuOutbox,
            ...(evolutionObserver || evolutionFailure ? { evolution } : {}),
            state: transition.state,
          }, { headers: { 'Cache-Control': 'no-store' } });
          };
          let lockEnabledObserver = false;
          try { lockEnabledObserver = isEvolutionRequested() === true; } catch { /* invalid configuration remains non-fatal to Plug */ }
          return await (lockEnabledObserver ? withCpsPlugLock(cpsId, processPlug) : processPlug());
        }

        if (!['unplug', 'unplugged'].includes(normalizedPhase)) {
          return jsonResponse({ error: 'Unsupported lifecycle transition.' }, { status: 400 });
        }
        const result = executeAcsmUnplug(cpsId, timestamp);
        return jsonResponse(result, {
          status: result.ok ? 200 : 404,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      for (const asset of Array.isArray(snapshot?.assets) ? snapshot.assets : []) {
        const cpsId = asset?.cps?.cpsId || asset?.cps?.id || asset?.interfaces?.baseTopic;
        const lifecyclePhase = String(asset?.cps?.lifecyclePhase || asset?.lifecyclePhase || '').trim().toLowerCase();
        if (cpsId && (lifecyclePhase === 'unplug' || lifecyclePhase === 'unplugged')) closeGovernancePlugCycle(cpsId);
      }
      return jsonResponse(updatePlugSnapshot(snapshot), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return jsonResponse({ error: error?.message || 'Invalid Plug snapshot.' }, { status: 400 });
    }
  };
}
