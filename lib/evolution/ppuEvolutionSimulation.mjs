import artifact from '../../docs/experiments/avm4-cpslai1/ppu-evolution-history.json' with { type: 'json' };
import functionalProjection from '../../docs/experiments/avm7-cpslai1-functional-projection.json' with { type: 'json' };
import { listExperimentalAasVersions } from './experimentalAasCatalog.mjs';

export const PPU_SIMULATION_NOTICE = 'OFFLINE PPU SIMULATION — NO PHYSICAL EXECUTION';
export const SIMULATED_AUTHORITY = Object.freeze({
  kind: 'SIMULATED_AUTHENTICATED_FIXTURE',
  subject: 'avm6-human-reviewer-fixture',
  trusted: true,
  operational: false,
});

const clone = (value) => structuredClone(value);

export function buildPpuSimulationModel() {
  const allowlist = listExperimentalAasVersions().map(({ version, sha256, description, sourceClassification }) => ({
    version, sha256, description, sourceClassification,
  }));
  return {
    schemaVersion: 'AVM-6-browser-simulation/1.0',
    scope: 'BROWSER_SESSION_ONLY',
    notice: PPU_SIMULATION_NOTICE,
    authority: SIMULATED_AUTHORITY,
    source: clone(artifact.source),
    allowlist,
    cycles: clone(artifact.cycles),
    functionalProjection: clone(functionalProjection),
  };
}

export function createPpuSimulationState(model = buildPpuSimulationModel()) {
  return {
    phase: 'UNPLUGGED', nextVersion: model.allowlist[0].version, active: null,
    completed: [], history: [], physicalEffects: 0, sequence: 0,
  };
}

function failure(state, code, message) {
  return { state, ok: false, code, message };
}

function success(state, code, message, idempotent = false) {
  return { state, ok: true, code, message, idempotent };
}

export function applyPpuSimulationAction(current, action, model = buildPpuSimulationModel()) {
  const state = clone(current);
  const type = String(action?.type || '').toUpperCase();
  if (type === 'PLUG') {
    const version = String(action.version || state.nextVersion).toLowerCase();
    const allowed = model.allowlist.find((item) => item.version === version);
    if (!allowed) return failure(current, 'AAS_NOT_ALLOWLISTED', 'A versão não pertence à allowlist AVM-2.');
    if (state.active) {
      if (state.active.aasVersion === version) return success(current, 'PLUG_RETRY_IDEMPOTENT', 'Retry reconhecido; ciclo e perfil preservados.', true);
      return failure(current, 'ACTIVE_CYCLE_CONFLICT', 'Unplug do ciclo ativo é obrigatório antes de novo Plug.');
    }
    const expected = model.cycles[state.sequence];
    if (!expected) return failure(current, 'SEQUENCE_COMPLETE', 'Os três ciclos documentados já foram reproduzidos.');
    if (expected.aasVersion !== version) return failure(current, 'AAS_SEQUENCE_MISMATCH', `O próximo ciclo documentado exige ${expected.aasVersion.toUpperCase()}.`);
    state.active = { ...clone(expected), lifecycleState: 'ACTIVE', profileStatus: 'PENDING_APPROVAL', playAllowed: false, played: false };
    state.phase = 'PLUG';
    state.nextVersion = model.allowlist[state.sequence + 1]?.version || version;
    state.history.push({ action: 'PLUG', version, cycleId: expected.plugCycleId, evidence: expected.references.plug.evidenceId, fixture: true });
    return success(state, 'PLUG_SIMULATED', `${version.toUpperCase()} reservada, ativada, congelada, arquivada e classificada pela evidência Evolution preservada.`);
  }
  if (!state.active) return failure(current, 'ACTIVE_CYCLE_REQUIRED', 'Nenhum ciclo experimental está ativo.');
  if (type === 'APPROVE') {
    if (action.authority?.kind !== SIMULATED_AUTHORITY.kind || action.authority?.trusted !== true || action.authority?.operational !== false) {
      return failure(current, 'SIMULATED_AUTHORITY_REQUIRED', 'A fixture de autoridade simulada e confiável é obrigatória.');
    }
    if (state.active.profileStatus === 'APPROVED') return success(current, 'APPROVAL_RETRY_IDEMPOTENT', 'Aprovação já registrada nesta sessão.', true);
    state.active.profileStatus = 'APPROVED';
    state.history.push({ action: 'APPROVE', profileId: state.active.profileId, authority: SIMULATED_AUTHORITY.kind });
    return success(state, 'PROFILE_APPROVED', 'Decisão humana simulada registrada no estado efêmero da sessão.');
  }
  if (type === 'PLAY') {
    if (state.active.played) return success(current, 'PLAY_RETRY_IDEMPOTENT', 'Play lógico já registrado; nenhum efeito foi repetido.', true);
    if (state.active.profileStatus !== 'APPROVED') return failure(current, 'GOVERNANCE_APPROVAL_REQUIRED', 'Play-gate bloqueou: perfil PENDING_APPROVAL.');
    if (state.active.lifecycleState !== 'ACTIVE') return failure(current, 'GOVERNANCE_ACTIVE_CYCLE_REQUIRED', 'Play-gate exige ciclo ACTIVE correlacionado.');
    state.active.playAllowed = true;
    state.active.played = true;
    state.phase = 'PLAY';
    state.history.push({ action: 'PLAY', cycleId: state.active.plugCycleId, logicalOnly: true, mqtt: false, opcua: false });
    return success(state, 'PLAY_LOGICAL_ONLY', 'Play lógico permitido pelo gate simulado; MQTT e OPC UA permanecem desativados.');
  }
  if (type === 'UNPLUG') {
    if (action.plugCycleId && action.plugCycleId !== state.active.plugCycleId) return failure(current, 'UNPLUG_IDENTITY_CONFLICT', 'Unplug divergente ou atrasado rejeitado.');
    const closed = { ...state.active, lifecycleState: 'CLOSED' };
    state.completed.push(closed);
    state.history.push({ action: 'UNPLUG', cycleId: closed.plugCycleId, evidence: closed.references.unplug?.evidenceId || 'AVM6_LOGICAL_FIXTURE', fixture: true });
    state.active = null;
    state.phase = 'UNPLUGGED';
    state.sequence += 1;
    return success(state, 'UNPLUG_SIMULATED', 'Ciclo correlacionado fechado; arquivo, comparação e decisão foram preservados.');
  }
  return failure(current, 'ACTION_UNSUPPORTED', 'Ação experimental não suportada.');
}
