import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getHcmRepositoryDiagnostics,
  listKnowledgeItems,
  registerKnowledgeItem,
} from '../services/memory/cognitiveEpisodicMemoryService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withIsolatedHcm(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-level1-history-'));
  const previous = process.env.HCM_STORE_PATH;
  process.env.HCM_STORE_PATH = path.join(root, 'hcm-store.json');
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.HCM_STORE_PATH;
    else process.env.HCM_STORE_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('HCM repository returns the latest real Level 1 records for cpslai1', async () => {
  await withIsolatedHcm(async () => {
    const records = [
      ['2026-10-15T10:00:00.000Z', 0.71],
      ['2026-10-15T10:00:03.000Z', 0.74],
      ['2026-10-15T10:00:06.000Z', 0.79],
    ];
    for (const [timestamp, oee] of records) {
      const result = registerKnowledgeItem({
        cpsId: 'cpslai1',
        source: 'level1',
        timestamp,
        originalKnowledge: { level: 'level1', timestamp, knowledge: { oee } },
      });
      assert.equal(result.reused, false);
    }

    registerKnowledgeItem({
      cpsId: 'cpslai2',
      source: 'level1',
      timestamp: '2026-10-15T10:00:09.000Z',
      originalKnowledge: { level: 'level1', knowledge: { oee: 0.99 } },
    });
    registerKnowledgeItem({
      cpsId: 'cpslai1',
      source: 'level2',
      timestamp: '2026-10-15T10:00:12.000Z',
      originalKnowledge: { level: 'level2', knowledge: { oee: 0.98 } },
    });

    const knowledgeItems = listKnowledgeItems({ cpsId: 'cpslai1', source: 'level1', limit: 25 });
    assert.equal(knowledgeItems.length, 3);
    assert.deepEqual(
      knowledgeItems.map((item) => item.timestamp),
      records.map(([timestamp]) => timestamp).reverse()
    );
    assert.ok(knowledgeItems.every((item) => item.cpsId === 'cpslai1'));
    assert.ok(knowledgeItems.every((item) => item.source === 'level1'));
    assert.equal(knowledgeItems[0].originalKnowledge.knowledge.oee, 0.79);
    const diagnostics = getHcmRepositoryDiagnostics();
    assert.equal(diagnostics.pathMode, 'configured');
    assert.equal(diagnostics.exists, true);
    assert.match(diagnostics.repositoryId, /^[a-f0-9]{12}$/);
  });
});

test('Level 1 history UI uses same-origin HCM and the analytics collector persists snapshots there', () => {
  const button = fs.readFileSync(path.join(projectRoot, 'components', 'HistoryRecordsButton.js'), 'utf8');
  const collector = fs.readFileSync(path.join(projectRoot, 'components', 'CPSAnalyticsFromContext.js'), 'utf8');
  const route = fs.readFileSync(path.join(projectRoot, 'app', 'api', 'hcm', 'knowledge', 'route.js'), 'utf8');

  assert.match(button, /\/api\/hcm\/knowledge\?\$\{query\.toString\(\)\}/);
  assert.match(button, /new URLSearchParams\(\{ cpsId, source: level, limit: '25' \}\)/);
  assert.doesNotMatch(button, /NEXT_PUBLIC_NODE_RED_BASE_URL|\/api\/history\//);
  assert.match(collector, /fetch\('\/api\/hcm\/knowledge'/);
  assert.match(collector, /source: 'level1'/);
  assert.match(collector, /originalKnowledge: snapshot/);
  assert.match(collector, /hasObjectContent\(analytics\.learning\)/);
  assert.match(collector, /lastLevel1SnapshotSignatureRef\.current = level1CognitiveSignature/);
  assert.match(collector, /pendingLevel1SnapshotSignatureRef\.current === level1CognitiveSignature/);
  assert.match(collector, /attempt < 3/);
  assert.match(collector, /data\?\.persisted && data\?\.knowledgeItem\?\.knowledgeId/);
  assert.match(route, /source: searchParams\.get\('source'\)/);
  assert.match(route, /repository: getHcmRepositoryDiagnostics\(\)/);
});
