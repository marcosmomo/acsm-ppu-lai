import fs from 'node:fs';
import path from 'node:path';

export const GOVERNANCE_RUNTIME_INVENTORY = Object.freeze([
  { path: 'services/governance/governanceStore.js', classifications: ['WRITER', 'READER', 'HCM_EFFECT', 'ACTION_EXECUTION', 'OUTBOX'] },
  { path: 'app/api/acsm/plug/route.js', classifications: ['WRITER', 'READER', 'OUTBOX', 'LIFECYCLE_ENTRY'] },
  { path: 'lib/acsm/plugPostHandler.mjs', classifications: ['WRITER', 'READER', 'IMPLICIT_CLOSE', 'OUTBOX', 'SNAPSHOT_IMPORT'] },
  { path: 'lib/acsm/unplugLifecycle.mjs', classifications: ['WRITER', 'EXTERNAL_LIFECYCLE', 'CPS_ONLY_CLOSE'] },
  { path: 'lib/acsm/plugStore.mjs', classifications: ['READER', 'SNAPSHOT_PROJECTION'] },
  { path: 'app/api/governance/cps/[cpsId]/route.js', classifications: ['WRITER', 'READER', 'POLICIES'] },
  { path: 'app/api/governance/cps/[cpsId]/profile/route.js', classifications: ['READER'] },
  { path: 'app/api/governance/cps/[cpsId]/approve/route.js', classifications: ['WRITER', 'HUMAN_DECISION'] },
  { path: 'app/api/governance/cps/[cpsId]/reject/route.js', classifications: ['WRITER', 'HUMAN_DECISION'] },
  { path: 'app/api/governance/check/route.js', classifications: ['WRITER', 'READER', 'ACTION_EXECUTION', 'HCM_EFFECT'] },
  { path: 'app/api/governance/action/[actionId]/approve/route.js', classifications: ['WRITER', 'HUMAN_DECISION', 'ACTION_EXECUTION'] },
  { path: 'app/api/governance/action/[actionId]/reject/route.js', classifications: ['WRITER', 'HUMAN_DECISION'] },
  { path: 'app/api/governance/cps/[cpsId]/play-gate/route.js', classifications: ['READER', 'PLAY_GATE'] },
  { path: 'context/CPSContext.js', classifications: ['CLIENT', 'HTTP_READER', 'HTTP_WRITER'] },
]);

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'test', 'docs', '.next'].includes(entry.name) || entry.name.includes('backup')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

export function auditGovernanceRuntimeInventory({ projectRoot, readFileSync = fs.readFileSync, discoverFiles = walk } = {}) {
  const classified = new Map(GOVERNANCE_RUNTIME_INVENTORY.map((item) => [item.path.replaceAll('\\', '/'), item]));
  const imports = [];
  for (const file of discoverFiles(projectRoot)) {
    const source = readFileSync(file, 'utf8');
    if (!/(?:from\s+|import\s*\()['"][^'"]*governanceStore(?:\.js)?['"]/.test(source) && !file.endsWith(path.join('services', 'governance', 'governanceStore.js'))) continue;
    const relative = path.relative(projectRoot, file).replaceAll('\\', '/');
    imports.push(relative);
  }
  const unclassified = imports.filter((file) => !classified.has(file));
  const missing = [...classified.keys()].filter((file) => !fs.existsSync(path.join(projectRoot, file)));
  return Object.freeze({ status: unclassified.length || missing.length ? 'BLOCKED' : 'PASS', imports: [...imports].sort(), unclassified: [...unclassified].sort(), missing: [...missing].sort(), inventory: GOVERNANCE_RUNTIME_INVENTORY });
}
