const fs = require('node:fs');
const path = require('node:path');

const workspace = process.cwd();
const repoFlowPath = path.join(workspace, 'node-red', 'supply-chain-coordinator-flow.json');
const activeFlowPath =
  process.argv[2] ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.node-red', 'flows.json');

const repoFlow = JSON.parse(fs.readFileSync(repoFlowPath, 'utf-8'));
const activeFlow = JSON.parse(fs.readFileSync(activeFlowPath, 'utf-8'));

const templateStore = repoFlow.find((node) => node.id === 'sc_coord_store_semantic_package');
const templateHcmNodes = repoFlow.filter((node) => String(node.id).startsWith('sc_hcm_'));

if (!templateStore || !templateHcmNodes.length) {
  throw new Error('Repository flow does not contain the HCM template nodes.');
}

const storeNodes = activeFlow.filter((node) => node.name === 'Store Level 3 package and decision');
if (!storeNodes.length) {
  throw new Error('Active Node-RED flow has no Store Level 3 package and decision node.');
}

const backupPath = activeFlowPath.replace(
  /\.json$/i,
  `.backup-hcm-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
);
fs.copyFileSync(activeFlowPath, backupPath);

const hcmTemplateIds = new Set(templateHcmNodes.map((node) => node.id));
const cleanedFlow = activeFlow.filter((node) => {
  if (String(node.id).startsWith('sc_hcm_')) return false;
  if (hcmTemplateIds.has(node.id)) return false;
  const serialized = JSON.stringify(node);
  return !serialized.includes('[HCM NODE-RED]') && !String(node.name || '').startsWith('HCM ');
});

const cloneForStore = (template, storeNode) => {
  const suffix = storeNode.id.replace(/[^a-zA-Z0-9_]/g, '_');
  const idMap = Object.fromEntries(
    templateHcmNodes.map((node) => [node.id, `${node.id}_${suffix}`])
  );
  const cloned = JSON.parse(JSON.stringify(template));
  cloned.id = idMap[template.id];
  cloned.z = storeNode.z;
  cloned.x = Number(template.x || 0);
  cloned.y = Number(template.y || 0) + storeNodes.indexOf(storeNode) * 220;
  cloned.wires = Array.isArray(template.wires)
    ? template.wires.map((group) =>
        Array.isArray(group) ? group.map((id) => idMap[id] || id) : group
      )
    : template.wires;
  return cloned;
};

const nextFlow = [...cleanedFlow];
let connectedStores = 0;
let connectedFeedbackBuilders = 0;

storeNodes.forEach((storeNode) => {
  const suffix = storeNode.id.replace(/[^a-zA-Z0-9_]/g, '_');
  const prepareId = `sc_hcm_prepare_open_${suffix}`;
  const effectivenessPrepareId = `sc_hcm_feedback_prepare_${suffix}`;
  const existingIndex = nextFlow.findIndex((node) => node.id === storeNode.id);
  if (existingIndex < 0) return;

  const updatedStore = {
    ...nextFlow[existingIndex],
    func: templateStore.func,
    wires: Array.isArray(nextFlow[existingIndex].wires) ? nextFlow[existingIndex].wires : [[]],
  };
  updatedStore.wires[0] = Array.from(new Set([...(updatedStore.wires[0] || []), prepareId]));
  nextFlow[existingIndex] = updatedStore;

  const feedbackIndex = nextFlow.findIndex(
    (node) => node.z === storeNode.z && node.name === 'Build Adaptive Supply Chain Feedback'
  );
  if (feedbackIndex >= 0) {
    const feedbackNode = {
      ...nextFlow[feedbackIndex],
      wires: Array.isArray(nextFlow[feedbackIndex].wires)
        ? nextFlow[feedbackIndex].wires
        : [[], [], [], []],
    };
    feedbackNode.wires[0] = Array.from(
      new Set([...(feedbackNode.wires[0] || []), effectivenessPrepareId])
    );
    nextFlow[feedbackIndex] = feedbackNode;
    connectedFeedbackBuilders += 1;
  }

  templateHcmNodes.forEach((template) => nextFlow.push(cloneForStore(template, storeNode)));
  connectedStores += 1;
});

fs.writeFileSync(activeFlowPath, `${JSON.stringify(nextFlow, null, 4)}\n`, 'utf-8');

console.log(
  JSON.stringify(
    {
      ok: true,
      activeFlowPath,
      backupPath,
      connectedStores,
      connectedFeedbackBuilders,
      hcmNodesAdded: connectedStores * templateHcmNodes.length,
    },
    null,
    2
  )
);
