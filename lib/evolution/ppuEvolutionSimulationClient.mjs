/**
 * Browser-only AVM-6 controller. It receives the document explicitly so the
 * same event wiring can be exercised by an isolated DOM contract test.
 */
export function installPpuEvolutionSimulation(document) {
  const model = JSON.parse(document.getElementById('model').textContent);
  const authority = model.authority;
  let state = {
    phase: 'UNPLUGGED', nextVersion: 'v1', active: null,
    completed: [], history: [], physicalEffects: 0, sequence: 0,
  };
  const byId = (id) => document.getElementById(id);
  const status = byId('status');
  const active = byId('active');
  const history = byId('history');
  const version = byId('version');
  const functional = byId('functional');
  const functionalContext = byId('functional-context');
  const functionalHistory = byId('functional-history');
  let inspectedHistoryVersion = null;

  function showResult(ok, code, message) {
    status.className = `panel status ${ok ? 'ok' : 'fail'}`;
    status.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: `${code} · ` }),
      document.createTextNode(message),
    );
    render();
  }

  function plug() {
    const selected = version.value;
    const expected = model.cycles[state.sequence];
    if (state.active) {
      const retry = state.active.aasVersion === selected;
      showResult(retry, retry ? 'PLUG_RETRY_IDEMPOTENT' : 'ACTIVE_CYCLE_CONFLICT', retry ? 'Retry reconhecido; identidade preservada.' : 'Feche o ciclo ativo primeiro.');
      return;
    }
    if (!expected) { showResult(false, 'SEQUENCE_COMPLETE', 'Os três ciclos foram reproduzidos.'); return; }
    if (!model.allowlist.some((item) => item.version === selected)) { showResult(false, 'AAS_NOT_ALLOWLISTED', 'Versão fora da allowlist AVM-2.'); return; }
    if (expected.aasVersion !== selected) { showResult(false, 'AAS_SEQUENCE_MISMATCH', `O próximo ciclo documentado exige ${expected.aasVersion.toUpperCase()}.`); return; }
    state.active = { ...structuredClone(expected), lifecycleState: 'ACTIVE', profileStatus: 'PENDING_APPROVAL', played: false };
    inspectedHistoryVersion = null;
    state.phase = 'PLUG';
    state.history.push({ action: 'PLUG', version: selected, cycleId: expected.plugCycleId, evolution: expected.evolution.status });
    version.value = model.allowlist[state.sequence + 1]?.version || selected;
    showResult(true, 'PLUG_SIMULATED', `${selected.toUpperCase()} ativa; seleção congelada, AAS arquivada e Evolution ${expected.evolution.status}.`);
  }

  function approve() {
    if (!state.active) { showResult(false, 'ACTIVE_CYCLE_REQUIRED', 'Nenhum ciclo ativo.'); return; }
    if (state.active.profileStatus === 'APPROVED') { showResult(true, 'APPROVAL_RETRY_IDEMPOTENT', 'Aprovação já registrada.'); return; }
    state.active.profileStatus = 'APPROVED';
    state.history.push({ action: 'APPROVE', profileId: state.active.profileId, authority: authority.kind });
    showResult(true, 'PROFILE_APPROVED', 'Fixture humana simulada autorizou o perfil.');
  }

  function play() {
    if (!state.active) { showResult(false, 'ACTIVE_CYCLE_REQUIRED', 'Nenhum ciclo ativo.'); return; }
    if (state.active.profileStatus !== 'APPROVED') { showResult(false, 'GOVERNANCE_APPROVAL_REQUIRED', 'Play-gate bloqueou o perfil PENDING_APPROVAL.'); return; }
    if (state.active.played) { showResult(true, 'PLAY_RETRY_IDEMPOTENT', 'Play lógico já registrado.'); return; }
    state.active.played = true;
    state.phase = 'PLAY';
    state.history.push({ action: 'PLAY', logicalOnly: true, mqtt: false, opcua: false });
    showResult(true, 'PLAY_LOGICAL_ONLY', 'Gate aprovado; nenhuma publicação MQTT ou execução OPC UA.');
  }

  function unplug() {
    if (!state.active) { showResult(false, 'ACTIVE_CYCLE_REQUIRED', 'Nenhum ciclo ativo.'); return; }
    const closed = { ...state.active, lifecycleState: 'CLOSED' };
    state.completed.push(closed);
    state.history.push({ action: 'UNPLUG', cycleId: closed.plugCycleId, evidence: closed.references.unplug?.evidenceId || 'AVM6_LOGICAL_FIXTURE' });
    state.active = null;
    state.phase = 'UNPLUGGED';
    state.sequence += 1;
    inspectedHistoryVersion = closed.aasVersion;
    showResult(true, 'UNPLUG_SIMULATED', 'Ciclo correlacionado fechado; histórico preservado.');
  }

  function line(label, value) {
    active.append(
      Object.assign(document.createElement('dt'), { textContent: label }),
      Object.assign(document.createElement('dd'), { textContent: value ?? '—' }),
    );
  }

  function render() {
    document.querySelectorAll('.phase').forEach((element) => element.classList.toggle('active', element.dataset.phase === state.phase));
    active.replaceChildren();
    if (state.active) {
      line('AAS', state.active.aasVersion.toUpperCase());
      line('Ciclo', state.active.plugCycleId);
      line('Perfil', state.active.profileId);
      line('Governança', state.active.profileStatus);
      line('Lifecycle', state.active.lifecycleState);
      line('Evolution', state.active.evolution.status);
      line('Diferenças', state.active.evolution.differences.map((item) => item.type).join(', ') || 'BASELINE');
    } else line('Estado', 'Sem ciclo ativo');
    history.replaceChildren(...state.history.map((item, index) => Object.assign(document.createElement('li'), {
      textContent: `${index + 1}. ${item.action} · ${item.version || item.cycleId || item.profileId || 'logical-only'}`,
    })));
    renderFunctional();
  }

  function renderFunctional() {
    const shownVersion = state.active?.aasVersion || inspectedHistoryVersion || version.value;
    const projection = model.functionalProjection.versions.find((item) => item.version === shownVersion);
    const context = state.active ? `Ciclo ativo congelado em ${shownVersion.toUpperCase()}` : inspectedHistoryVersion ? `Histórico da sessão · ${shownVersion.toUpperCase()}` : `Prévia da seleção · ${shownVersion.toUpperCase()}`;
    const next = state.active && version.value !== state.active.aasVersion ? ` · Próximo Plug selecionado: ${version.value.toUpperCase()}` : '';
    functionalContext.textContent = context + next;
    functional.replaceChildren();
    const meta = Object.assign(document.createElement('p'), { className: 'functional-meta', textContent: `CPS ${projection.cpsId} · AAS ${projection.aasId} · Asset ${projection.assetId}` });
    const hash = document.createElement('details');
    const summary = Object.assign(document.createElement('summary'), { textContent: `SHA-256 ${projection.sha256.slice(0, 12)}…` });
    hash.append(summary, Object.assign(document.createElement('code'), { textContent: projection.sha256 }));
    const list = Object.assign(document.createElement('div'), { className: 'cap-list' });
    for (const capability of projection.capabilities) {
      const card = Object.assign(document.createElement('article'), { className: `capability${capability.experimental ? ' experimental' : ''}` });
      card.append(Object.assign(document.createElement('h3'), { textContent: capability.name + (capability.experimental ? ' · EXPERIMENTAL' : '') }));
      card.append(Object.assign(document.createElement('code'), { textContent: capability.identity }));
      const attrs = Object.assign(document.createElement('ul'), { className: 'attrs' });
      for (const [name, attribute] of Object.entries(capability.attributes)) {
        const value = String(attribute.value);
        const item = Object.assign(document.createElement('li'), { textContent: `${name}: ${value}` });
        if (value === 'true' || value === 'false') item.className = value === 'true' ? 'support-true' : 'support-false';
        attrs.append(item);
      }
      card.append(attrs, Object.assign(document.createElement('small'), { textContent: capability.evidenceLevel }));
      list.append(card);
    }
    const services = Object.assign(document.createElement('details'), { className: 'functional-meta' });
    services.append(Object.assign(document.createElement('summary'), { textContent: `Serviços declarados (${projection.services.length})` }), Object.assign(document.createElement('p'), { textContent: projection.services.map((item) => item.name).join(' · ') }));
    functional.append(meta, hash, list, services, Object.assign(document.createElement('p'), { className: 'functional-meta', textContent: 'false significa ausência de suporte funcional declarado neste cenário; não é leitura instantânea de sensor.' }));
    functionalHistory.replaceChildren();
    for (const completed of state.completed) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: `Consultar ${completed.aasVersion.toUpperCase()} · CLOSED` });
      button.addEventListener('click', () => { inspectedHistoryVersion = completed.aasVersion; renderFunctional(); });
      functionalHistory.append(button);
    }
  }

  byId('plug').addEventListener('click', plug);
  byId('approve').addEventListener('click', approve);
  byId('play').addEventListener('click', play);
  byId('unplug').addEventListener('click', unplug);
  version.addEventListener('change', () => { if (!state.active) inspectedHistoryVersion = null; renderFunctional(); });
  render();
  return { getState: () => structuredClone(state) };
}
