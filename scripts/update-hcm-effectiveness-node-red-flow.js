const fs = require('node:fs');

const file = process.argv[2] || 'node-red/supply-chain-coordinator-flow.json';
const flow = JSON.parse(fs.readFileSync(file, 'utf-8'));

const byId = (id) => {
  const node = flow.find((item) => item.id === id);
  if (!node) throw new Error(`Missing node ${id}`);
  return node;
};

const ensureWire = (node, outputIndex, targetId) => {
  node.wires = Array.isArray(node.wires) ? node.wires : [];
  node.wires[outputIndex] = Array.isArray(node.wires[outputIndex])
    ? node.wires[outputIndex]
    : [];
  if (!node.wires[outputIndex].includes(targetId)) node.wires[outputIndex].push(targetId);
};

const removeExistingEffectivenessNodes = () => {
  const ids = new Set([
    'sc_hcm_feedback_prepare',
    'sc_hcm_feedback_open_request',
    'sc_hcm_feedback_select_episode',
    'sc_hcm_feedback_detail_request',
    'sc_hcm_feedback_build_event',
    'sc_hcm_feedback_event_request',
    'sc_hcm_feedback_build_effectiveness',
    'sc_hcm_feedback_effectiveness_request',
    'sc_hcm_feedback_after_effectiveness',
  ]);
  for (let index = flow.length - 1; index >= 0; index -= 1) {
    if (ids.has(flow[index].id)) flow.splice(index, 1);
  }
  flow.forEach((node) => {
    if (!Array.isArray(node.wires)) return;
    node.wires = node.wires.map((group) =>
      Array.isArray(group) ? group.filter((id) => !ids.has(id)) : group
    );
  });
};

removeExistingEffectivenessNodes();

const feedbackBuilder = byId('sc_build_supply_chain_feedback');
ensureWire(feedbackBuilder, 0, 'sc_hcm_feedback_prepare');

const newNodes = [
  {
    id: 'sc_hcm_feedback_prepare',
    type: 'function',
    z: 'sc_coord_tab',
    name: 'HCM Effectiveness - detect new OEE',
    func: `function toNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function getBaseUrl() {
    const fromEnv = typeof env !== "undefined" && env.get ? env.get("HCM_API_BASE_URL") : "";
    const fromProcess = typeof process !== "undefined" && process.env ? process.env.HCM_API_BASE_URL : "";
    return String(fromEnv || fromProcess || "http://localhost:3000/api/hcm").replace(/\\/+$/, "");
}

const history = Array.isArray(global.get("supplychain_feedback_history")) ? global.get("supplychain_feedback_history") : [];
const latest = history.length ? history[history.length - 1] : null;
const afterGlobalOEE = toNumber(latest?.globalOEE, null);

if (afterGlobalOEE === null) {
    node.warn("[HCM EFFECTIVENESS] skipped: invalid afterGlobalOEE");
    return null;
}

const readingSignature = JSON.stringify({
    timestamp: latest?.timestamp || latest?.ts || msg.payload?.timestamp || "",
    afterGlobalOEE: Math.round(afterGlobalOEE * 10000) / 10000
});
if (global.get("hcm_effectiveness_last_reading_signature") === readingSignature) {
    node.warn("[HCM EFFECTIVENESS] skipped: duplicate OEE reading");
    return null;
}
global.set("hcm_effectiveness_pending_reading_signature", readingSignature);

msg.hcmEffectiveness = {
    baseUrl: getBaseUrl(),
    readingSignature,
    latestHistory: latest,
    afterGlobalOEE,
    feedbackPayload: msg.payload || {}
};
msg.method = "GET";
msg.url = msg.hcmEffectiveness.baseUrl + "/episodes/open";
msg.headers = { "Content-Type": "application/json" };
delete msg.payload;
node.warn("[HCM EFFECTIVENESS] new OEE reading detected " + JSON.stringify({ afterGlobalOEE, timestamp: latest?.timestamp }));
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 1120,
    y: 160,
    wires: [['sc_hcm_feedback_open_request']],
  },
  {
    id: 'sc_hcm_feedback_open_request',
    type: 'http request',
    z: 'sc_coord_tab',
    name: 'HCM GET open episodes',
    method: 'use',
    ret: 'obj',
    paytoqs: 'ignore',
    url: '',
    tls: '',
    persist: false,
    proxy: '',
    insecureHTTPParser: false,
    authType: '',
    senderr: false,
    headers: [],
    x: 1390,
    y: 160,
    wires: [['sc_hcm_feedback_select_episode']],
  },
  {
    id: 'sc_hcm_feedback_select_episode',
    type: 'function',
    z: 'sc_coord_tab',
    name: 'HCM Effectiveness - select open episode',
    func: `const body = typeof msg.payload === "string" ? (() => { try { return JSON.parse(msg.payload); } catch (err) { return {}; } })() : (msg.payload || {});
const episodes = Array.isArray(body.episodes) ? body.episodes : [];
if (!episodes.length) {
    node.warn("[HCM EFFECTIVENESS] skipped: no open episode");
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}

const latestCritical = String(msg.hcmEffectiveness?.latestHistory?.criticalAcsm || "").toLowerCase();
const selected = episodes.find((episode) => String(episode.criticalACSM || "").toLowerCase() === latestCritical) || episodes[0];
if (!selected?.episodeId) {
    node.warn("[HCM EFFECTIVENESS] skipped: no open episode");
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}

msg.hcmEffectiveness.episodeId = selected.episodeId;
msg.method = "GET";
msg.url = msg.hcmEffectiveness.baseUrl + "/episode/" + encodeURIComponent(selected.episodeId);
msg.headers = { "Content-Type": "application/json" };
delete msg.payload;
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 1680,
    y: 160,
    wires: [['sc_hcm_feedback_detail_request']],
  },
  {
    id: 'sc_hcm_feedback_detail_request',
    type: 'http request',
    z: 'sc_coord_tab',
    name: 'HCM GET episode detail',
    method: 'use',
    ret: 'obj',
    paytoqs: 'ignore',
    url: '',
    tls: '',
    persist: false,
    proxy: '',
    insecureHTTPParser: false,
    authType: '',
    senderr: false,
    headers: [],
    x: 1960,
    y: 160,
    wires: [['sc_hcm_feedback_build_event']],
  },
  {
    id: 'sc_hcm_feedback_build_event',
    type: 'function',
    z: 'sc_coord_tab',
    name: 'HCM Effectiveness - build feedback event',
    func: `function toNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function pickOee(source) {
    if (!source || typeof source !== "object") return null;
    return toNumber(
        source.globalOEE?.oee ??
            source.globalOEE?.current ??
            source.oee?.oee ??
            source.oee?.current ??
            source.oeeGlobal ??
            source.globalOEE,
        null
    );
}

const body = typeof msg.payload === "string" ? (() => { try { return JSON.parse(msg.payload); } catch (err) { return {}; } })() : (msg.payload || {});
const episode = body.episode || {};
if (episode.status && episode.status !== "open") {
    node.warn("[HCM EFFECTIVENESS] skipped: already closed");
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}

const decisions = Array.isArray(episode.decisions) ? episode.decisions : [];
if (!decisions.length) {
    node.warn("[HCM EFFECTIVENESS] skipped: no decision");
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}
if (Array.isArray(episode.effectiveness) && episode.effectiveness.length) {
    node.warn("[HCM EFFECTIVENESS] skipped: already closed");
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}

const latestDecision = decisions.slice().sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))[0];
const readingTs = Date.parse(msg.hcmEffectiveness?.latestHistory?.timestamp || msg.hcmEffectiveness?.feedbackPayload?.timestamp || "");
const decisionTs = Date.parse(latestDecision?.timestamp || "");
if (Number.isFinite(readingTs) && Number.isFinite(decisionTs) && readingTs <= decisionTs) {
    node.warn("[HCM EFFECTIVENESS] skipped: no new OEE reading after decision");
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}

const targetACSM = String(latestDecision.targetACSM || episode.criticalACSM || msg.hcmEffectiveness?.latestHistory?.criticalAcsm || "global").toLowerCase();
const context = episode.contextSnapshot || {};
const beforeTargetOEE = pickOee(context[targetACSM]) ?? pickOee(context?.coordinatorPayload?.[targetACSM]) ?? episode.globalOEE ?? null;
const raw = global.get("supplychain_level3_raw_payload") || {};
const currentAcsms = raw.coordinatorPayload || raw.acsms || {};
const afterTargetOEE = pickOee(currentAcsms[targetACSM]) ?? msg.hcmEffectiveness.afterGlobalOEE;

msg.hcmEffectiveness.episode = episode;
msg.hcmEffectiveness.latestDecision = latestDecision;
msg.hcmEffectiveness.effectivenessPayload = {
    episodeId: episode.episodeId,
    beforeGlobalOEE: episode.globalOEE,
    afterGlobalOEE: msg.hcmEffectiveness.afterGlobalOEE,
    targetACSM,
    beforeTargetOEE,
    afterTargetOEE,
    notes: "Effectiveness calculated after new OEE reading"
};
msg.hcmEffectiveness.feedbackEventPayload = {
    episodeId: episode.episodeId,
    source: "coordinator",
    eventType: "feedback",
    content: {
        feedbackType: "implicit_oee_feedback",
        afterGlobalOEE: msg.hcmEffectiveness.afterGlobalOEE,
        message: "New OEE reading received after coordinator decision",
        reading: msg.hcmEffectiveness.latestHistory,
        feedback: msg.hcmEffectiveness.feedbackPayload
    }
};

node.warn("[HCM EFFECTIVENESS] open episode with decision found " + JSON.stringify({ episodeId: episode.episodeId, decisionId: latestDecision.decisionId }));
msg.method = "POST";
msg.url = msg.hcmEffectiveness.baseUrl + "/event";
msg.headers = { "Content-Type": "application/json" };
msg.payload = msg.hcmEffectiveness.feedbackEventPayload;
node.warn("[HCM EFFECTIVENESS] request feedback event " + JSON.stringify(msg.payload));
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 2250,
    y: 160,
    wires: [['sc_hcm_feedback_event_request']],
  },
  {
    id: 'sc_hcm_feedback_event_request',
    type: 'http request',
    z: 'sc_coord_tab',
    name: 'HCM POST feedback event',
    method: 'use',
    ret: 'obj',
    paytoqs: 'ignore',
    url: '',
    tls: '',
    persist: false,
    proxy: '',
    insecureHTTPParser: false,
    authType: '',
    senderr: false,
    headers: [],
    x: 2550,
    y: 160,
    wires: [['sc_hcm_feedback_build_effectiveness']],
  },
  {
    id: 'sc_hcm_feedback_build_effectiveness',
    type: 'function',
    z: 'sc_coord_tab',
    name: 'HCM Effectiveness - build request',
    func: `const body = typeof msg.payload === "string" ? (() => { try { return JSON.parse(msg.payload); } catch (err) { return {}; } })() : (msg.payload || {});
if (body?.ok === false || body?.error) {
    node.warn("[HCM EFFECTIVENESS] error feedback event response " + JSON.stringify(body));
}

msg.method = "POST";
msg.url = msg.hcmEffectiveness.baseUrl + "/effectiveness";
msg.headers = { "Content-Type": "application/json" };
msg.payload = msg.hcmEffectiveness.effectivenessPayload;
node.warn("[HCM EFFECTIVENESS] request " + JSON.stringify(msg.payload));
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 2840,
    y: 160,
    wires: [['sc_hcm_feedback_effectiveness_request']],
  },
  {
    id: 'sc_hcm_feedback_effectiveness_request',
    type: 'http request',
    z: 'sc_coord_tab',
    name: 'HCM POST effectiveness after OEE',
    method: 'use',
    ret: 'obj',
    paytoqs: 'ignore',
    url: '',
    tls: '',
    persist: false,
    proxy: '',
    insecureHTTPParser: false,
    authType: '',
    senderr: false,
    headers: [],
    x: 3140,
    y: 160,
    wires: [['sc_hcm_feedback_after_effectiveness']],
  },
  {
    id: 'sc_hcm_feedback_after_effectiveness',
    type: 'function',
    z: 'sc_coord_tab',
    name: 'HCM Effectiveness - response',
    func: `const body = typeof msg.payload === "string" ? (() => { try { return JSON.parse(msg.payload); } catch (err) { return {}; } })() : (msg.payload || {});
if (body?.ok === false || body?.error) {
    node.warn("[HCM EFFECTIVENESS] error " + JSON.stringify(body));
    global.set("hcm_effectiveness_pending_reading_signature", null);
    return null;
}
global.set("hcm_effectiveness_last_reading_signature", msg.hcmEffectiveness.readingSignature);
global.set("hcm_effectiveness_pending_reading_signature", null);
node.warn("[HCM EFFECTIVENESS] response " + JSON.stringify(body));
return null;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 3450,
    y: 160,
    wires: [[]],
  },
];

flow.push(...newNodes);

fs.writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`, 'utf-8');
console.log(`updated ${file}`);
