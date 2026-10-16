import report from '../../docs/experiments/e1-cpslai1/report.json' with { type: 'json' };

const MISSING = 'Não informado no relatório';
const NOT_APPLICABLE = 'Não aplicável neste cenário';

function names(items) {
  return Array.isArray(items) ? items.map((item) => item?.name).filter((name) => typeof name === 'string') : null;
}

function scenarioModel(scenario) {
  const result = scenario?.result?.result;
  const governance = scenario?.result?.governanceReplug ?? (scenario?.id === 'E1.8' ? report.governanceReplug : null);
  const evolution = governance?.evolution;
  const diff = Array.isArray(result?.differences) ? result.differences.map((item) => ({
    type: item?.type ?? MISSING,
    before: item?.beforeName ?? null,
    after: item?.currentName ?? null,
  })) : [];
  const hashes = scenario?.result?.hashes ?? null;

  return {
    id: scenario.id,
    label: scenario.label,
    pass: scenario.pass === true,
    outcome: scenario.actual ?? MISSING,
    classification: result?.status ?? evolution?.v2 ?? result?.actual ?? scenario.actual ?? MISSING,
    reason: result?.reason ?? null,
    capabilitiesBefore: names(result?.capabilitiesBefore),
    capabilitiesAfter: names(result?.capabilitiesAfter),
    differences: diff,
    hashes: hashes ? {
      aasV1: hashes.aasV1 ?? null,
      aasV2: hashes.aasV2 ?? null,
      functionalV1: hashes.functionalV1 ?? null,
      functionalV2: hashes.functionalV2 ?? null,
    } : null,
    retry: scenario?.result?.retry ? {
      duplicate: scenario.result.retry.duplicate === true,
      status: scenario.result.retry.duplicate === true ? 'NO_OP' : scenario.result.retry.status ?? MISSING,
    } : null,
    governance: governance ? {
      firstProfile: governance.firstCycle?.profileId ?? null,
      firstCycleState: governance.firstCycle?.state ?? null,
      firstEvent: governance.cycles?.[0]?.plugEventId ?? null,
      firstCycle: governance.cycles?.[0]?.plugCycleId ?? null,
      currentProfile: governance.secondCycle?.profileId ?? null,
      currentEvent: governance.cycles?.[1]?.plugEventId ?? null,
      currentCycle: governance.cycles?.[1]?.plugCycleId ?? null,
      currentProfileStatus: governance.secondCycle?.status ?? null,
      currentCycleState: governance.secondCycle?.state ?? governance.secondCycle?.plugCycleStatus ?? null,
      approvalNotInherited: governance.approvalNotInherited === true,
      playBeforeApproval: governance.gateBeforeApproval ?? null,
      playAfterReplug: governance.gateAfterReplug ?? null,
      playBlocked: governance.playBlocked === true,
      evolutionGovernanceUnchanged: evolution?.governanceUnchangedV2 === true,
      physicalValidationInferred: evolution?.physicalValidationInferred === true,
    } : null,
  };
}

export function buildE1OfflineViewModel() {
  return {
    title: report.title,
    generatedAt: report.generatedAt,
    source: {
      cpsId: report.source.cpsId,
      aasId: report.source.aasId,
      assetId: report.source.assetId,
      sourcePath: report.source.path,
      aasSha256: report.source.aasSha256,
      evidenceScope: report.source.evidenceScope,
      completeness: report.v1Extraction.completeness,
    },
    v1Capabilities: names(report.v1Extraction.capabilities) ?? [],
    v1Services: names(report.v1Extraction.services) ?? [],
    scenarios: report.scenarios.map(scenarioModel),
  };
}

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function renderE1OfflineHtml(model = buildE1OfflineViewModel()) {
  const json = JSON.stringify(model).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const options = model.scenarios.map((scenario) => `<option value="${esc(scenario.id)}">${esc(scenario.id)} — ${esc(scenario.label)}</option>`).join('');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Experimento E1 · Evolution Offline</title>
<style>
:root{color-scheme:light;--navy:#12345a;--blue:#075aa6;--ink:#18324b;--muted:#63778b;--line:#d8e2ed;--paper:#fff;--canvas:#f2f6fa;--amber:#fff2cc;--amber-ink:#725100;--green:#176b48;--red:#a83838}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 Arial,Helvetica,sans-serif}.top{background:var(--navy);color:#fff;padding:26px max(22px,calc((100vw - 1120px)/2))}.top h1{margin:0 0 4px;font-size:25px}.top p{margin:0;color:#dce9f5}.offline{display:inline-block;margin-top:14px;padding:5px 11px;border-radius:999px;background:var(--amber);color:var(--amber-ink);font-size:12px;font-weight:800;letter-spacing:.08em}.wrap{max-width:1120px;margin:24px auto;padding:0 20px 42px}.notice{padding:13px 16px;border-left:4px solid #dda400;background:#fff8e6;border-radius:5px;margin-bottom:20px}.toolbar,.card{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:16px;box-shadow:0 2px 8px #173a5a0a}.toolbar label{display:block;font-size:13px;color:var(--muted);font-weight:700;margin-bottom:7px}.toolbar select{width:100%;max-width:680px;padding:11px;border:1px solid #aebfd0;border-radius:6px;background:white;color:var(--ink);font-size:15px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{margin:0}.card h2{font-size:16px;margin:0 0 12px;color:var(--navy)}.card.wide{grid-column:1/-1}.pill{display:inline-block;border-radius:5px;background:#e7f0f9;color:var(--blue);padding:3px 8px;font-weight:800;font-size:12px}.kv{display:grid;grid-template-columns:minmax(130px, .7fr) 1.3fr;gap:7px 12px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}.hash{font:12px/1.45 Consolas,monospace;word-break:break-all}.chips{display:flex;flex-wrap:wrap;gap:7px;padding:0;margin:0;list-style:none}.chips li{background:#edf3f8;border-radius:5px;padding:5px 8px}.diff{border-left:3px solid var(--line);padding:8px 10px;margin:8px 0;background:#f8fafc}.diff b{font-size:12px;color:var(--blue);margin-right:8px}.empty{color:var(--muted);font-style:italic}.pass{color:var(--green);font-weight:700}.blocked{color:var(--red);font-weight:700}.foot{margin-top:18px;color:var(--muted);font-size:12px}.summary{font-size:13px;color:var(--muted)}@media(max-width:720px){.grid{grid-template-columns:1fr}.card.wide{grid-column:auto}.wrap{padding-left:14px;padding-right:14px}.kv{grid-template-columns:1fr;gap:2px}.kv dd{margin-bottom:8px}}
</style></head><body>
<header class="top"><h1>CPS-LAI-01 · Distribution/Conveyor Station</h1><p>Painel documental do Experimento E1 — Evolution e ciclo simulado</p><span class="offline">OFFLINE SIMULATION · SOMENTE LEITURA</span></header>
<main class="wrap"><div class="notice"><strong>Simulação offline.</strong> Os resultados vêm do relatório versionado do E1. Não representam validação física nem estado operacional atual.</div>
<section class="toolbar"><label for="scenario">Selecionar cenário E1</label><select id="scenario">${options}</select></section>
<section id="view" aria-live="polite"></section>
<p class="foot">Fonte: docs/experiments/e1-cpslai1/report.json · AAS V1: ${esc(model.source.aasId)} · gerado em ${esc(model.generatedAt)} · nenhuma ação operacional está disponível nesta página.</p></main>
<script type="application/json" id="e1-model">${json}</script>
<script>
(()=>{const data=JSON.parse(document.getElementById('e1-model').textContent);const select=document.getElementById('scenario');const root=document.getElementById('view');const missing=${JSON.stringify(MISSING)};const na=${JSON.stringify(NOT_APPLICABLE)};const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==null&&text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};const card=(title,wide=false)=>{const n=el('section',null,'card'+(wide?' wide':''));n.append(el('h2',title));return n};const line=(dl,label,value,cls)=>{dl.append(el('dt',label));dl.append(el('dd',value??missing,cls||''))};const list=(parent,items)=>{if(items===null){parent.append(el('p',missing,'empty'));return}if(!items.length){parent.append(el('p','Nenhuma capacidade registrada','empty'));return}const ul=el('ul',null,'chips');items.forEach(x=>ul.append(el('li',x)));parent.append(ul)};function render(){const s=data.scenarios.find(x=>x.id===select.value);root.replaceChildren();if(!s)return;const head=card('Resultado do cenário');const dl=el('dl',null,'kv');line(dl,'Cenário',s.id+' — '+s.label);line(dl,'Classificação Evolution',s.classification);line(dl,'Resultado documentado',s.outcome);line(dl,'Avaliação E1',s.pass?'PASS':'Não informado');if(s.reason)line(dl,'Motivo',s.reason);head.append(dl);root.append(head);
const versions=card('Snapshots e hashes');const hd=el('dl',null,'kv');for(const [key,label] of [['aasV1','AAS V1 SHA-256'],['aasV2','AAS V2 SHA-256'],['functionalV1','Funcional V1 SHA-256'],['functionalV2','Funcional V2 SHA-256']])line(hd,label,s.hashes?(s.hashes[key]??na):missing,'hash');versions.append(hd);root.append(versions);
const before=card('Capacidades antes');list(before,s.capabilitiesBefore);root.append(before);const after=card('Capacidades depois');list(after,s.capabilitiesAfter);root.append(after);
const diff=card('Diferenças funcionais',true);if(!s.differences.length)diff.append(el('p',s.classification==='INDETERMINATE'?'Nenhuma diferença conclusiva; o relatório classificou o caso como indeterminado.':'Nenhuma diferença funcional registrada.','empty'));else s.differences.forEach(d=>{const row=el('div',null,'diff');row.append(el('b',d.type));row.append(document.createTextNode((d.before??'—')+' → '+(d.after??'—')));diff.append(row)});root.append(diff);
const retry=card('Retry / idempotência');const rd=el('dl',null,'kv');line(rd,'Resultado',s.retry?s.retry.status:(s.id==='E1.7'?'NO_OP':missing));line(rd,'Evento duplicado',s.retry?(s.retry.duplicate?'Sim':'Não'):missing);retry.append(rd);root.append(retry);
const gov=card('Governança simulada e Play-gate');if(!s.governance){gov.append(el('p','Não registrado para este cenário.','empty'))}else{const gd=el('dl',null,'kv');line(gd,'Evento anterior',s.governance.firstEvent);line(gd,'Ciclo anterior',s.governance.firstCycle);line(gd,'Perfil anterior',s.governance.firstProfile);line(gd,'Estado do ciclo anterior',s.governance.firstCycleState);line(gd,'Evento do replug',s.governance.currentEvent);line(gd,'Ciclo do replug',s.governance.currentCycle);line(gd,'Perfil do replug',s.governance.currentProfile);line(gd,'Estado do perfil novo',s.governance.currentProfileStatus);line(gd,'Estado do ciclo novo',s.governance.currentCycleState);line(gd,'Aprovação antiga herdada',s.governance.approvalNotInherited?'Não':'Não informado');line(gd,'Play antes da aprovação',s.governance.playBeforeApproval);line(gd,'Play após replug',s.governance.playAfterReplug);line(gd,'Play bloqueado',s.governance.playBlocked?'Sim':'Não informado',s.governance.playBlocked?'blocked':'');line(gd,'Evolution preservou governança',s.governance.evolutionGovernanceUnchanged?'Sim':'Não informado');line(gd,'Validação física inferida',s.governance.physicalValidationInferred?'Sim':'Não');gov.append(gd)}root.append(gov);
const v1=card('Referência da AAS V1 extraída',true);const vd=el('dl',null,'kv');line(vd,'Capacidades declaradas',String(data.v1Capabilities.length));line(vd,'Serviços declarados',String(data.v1Services.length));line(vd,'Completude',data.source.completeness);v1.append(vd);list(v1,data.v1Capabilities);v1.append(el('p','Declarações documentais; não equivalem a capacidades fisicamente validadas.','summary'));root.append(v1)}select.addEventListener('change',render);render()})();
</script></body></html>`;
}
