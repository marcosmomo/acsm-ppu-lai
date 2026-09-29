const fs = require('node:fs');

const file = process.argv[2] || 'node-red/supply-chain-coordinator-flow.json';
const flow = JSON.parse(fs.readFileSync(file, 'utf-8'));

const byId = (id) => {
  const node = flow.find((item) => item.id === id);
  if (!node) throw new Error(`Missing node ${id}`);
  return node;
};

const prepare = byId('sc_hcm_prepare_open');
prepare.func = prepare.func.replace(
  `if (global.get("hcm_node_red_last_signature") === signature) {
    node.warn("[HCM NODE-RED] skipped duplicate signature " + signature);
    return null;
}

const contextSnapshot`,
  `if (global.get("hcm_node_red_last_signature") === signature || global.get("hcm_node_red_pending_signature") === signature) {
    node.warn("[HCM NODE-RED] skipped duplicate signature " + signature);
    return null;
}
global.set("hcm_node_red_pending_signature", signature);

const contextSnapshot`
);

const afterOpen = byId('sc_hcm_after_open');
afterOpen.func = afterOpen.func.replace(
  `if (!episodeId) {
    node.warn("[HCM NODE-RED] error opening episode: missing episodeId");
    return null;
}`,
  `if (!episodeId) {
    node.warn("[HCM NODE-RED] error opening episode: missing episodeId");
    global.set("hcm_node_red_pending_signature", null);
    return null;
}`
);

const afterDecision = byId('sc_hcm_after_decision');
afterDecision.func = afterDecision.func.replace(
  `if (body?.ok === false || body?.error) {
    node.warn("[HCM NODE-RED] error decision response " + JSON.stringify(body));
    return null;
}
global.set("hcm_node_red_last_signature", msg.hcm.signature);`,
  `if (body?.ok === false || body?.error) {
    node.warn("[HCM NODE-RED] error decision response " + JSON.stringify(body));
    global.set("hcm_node_red_pending_signature", null);
    return null;
}
global.set("hcm_node_red_last_signature", msg.hcm.signature);
global.set("hcm_node_red_pending_signature", null);`
);

fs.writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`, 'utf-8');
console.log(`updated ${file}`);
