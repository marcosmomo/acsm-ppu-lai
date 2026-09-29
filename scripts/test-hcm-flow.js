const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const storePath = path.join(process.cwd(), 'data', 'hcm-test-store.json');
process.env.HCM_STORE_PATH = storePath;

const emptyStore = {
  episodes: [],
  events: [],
  decisions: [],
  effectiveness: [],
};

const resetStore = () => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(emptyStore, null, 2)}\n`, 'utf-8');
};

const readStore = () => JSON.parse(fs.readFileSync(storePath, 'utf-8'));

const expectReject = (fn, expectedStatus) => {
  try {
    fn();
  } catch (error) {
    assert.equal(error.status, expectedStatus);
    return;
  }
  throw new Error(`Expected HCM error with status ${expectedStatus}.`);
};

(async () => {
  resetStore();

  const hcm = await import('../services/memory/collectiveEpisodicMemoryService.js');

  const opened = hcm.openEpisode({
    globalOEE: 0.72,
    targetOEE: 0.85,
    criticalACSM: 'acsm1',
    corporateGoal: { targetOEE: 0.85 },
    contextSnapshot: {
      globalOEE: 0.72,
      targetOEE: 0.85,
      risk: 'high',
      evidence: ['global_oee_gap'],
    },
  });

  assert.equal(opened.reused, false);
  assert.equal(opened.episode.status, 'open');
  assert.ok(opened.episode.episodeId);

  const episodeId = opened.episode.episodeId;
  assert.equal(hcm.listEpisodes({ status: 'open' }).length, 1);
  assert.equal(hcm.listEpisodes({ status: 'open' })[0].episodeId, episodeId);

  const reused = hcm.openEpisode({
    globalOEE: 0.71,
    targetOEE: 0.85,
    criticalACSM: 'acsm1',
    contextSnapshot: { risk: 'high', evidence: ['same_trigger'] },
  });

  assert.equal(reused.reused, true);
  assert.equal(reused.episode.episodeId, episodeId);
  assert.equal(hcm.listEpisodes({ status: 'open' }).length, 1);

  hcm.registerEvent({
    episodeId,
    source: 'acsm1',
    eventType: 'learning',
    content: { pattern: 'availability_loss' },
  });
  hcm.registerEvent({
    episodeId,
    source: 'acsm2',
    eventType: 'reasoning',
    content: { rationale: 'buffer starvation propagates to ACSM1' },
  });
  hcm.registerEvent({
    episodeId,
    source: 'coordinator',
    eventType: 'recommendation',
    content: {},
  });

  const decision = hcm.registerDecision({
    episodeId,
    targetACSM: 'acsm1',
    strategy: 'recover_availability_to_target',
    recommendation: 'Prioritize ACSM1 availability recovery.',
    rationale: 'Global OEE is below corporate target.',
    expectedGain: 0.03,
  });

  assert.equal(decision.decision.episodeId, episodeId);

  const effective = hcm.registerEffectiveness({
    episodeId,
    beforeGlobalOEE: 0.72,
    afterGlobalOEE: 0.735,
    beforeTargetOEE: 0.7,
    afterTargetOEE: 0.72,
    notes: 'Measured after coordinator decision.',
  });

  assert.equal(effective.effectiveness.globalOEEGain, 0.015);
  assert.equal(effective.effectiveness.result, 'effective');
  assert.equal(effective.episode.status, 'closed');

  const complete = hcm.getEpisode(episodeId);
  assert.equal(complete.chain.initialContext.globalOEE, 0.72);
  assert.equal(complete.events.length, 4);
  assert.equal(complete.chain.feedback.length, 1);
  assert.equal(complete.decisions.length, 1);
  assert.equal(complete.effectiveness.length, 1);

  const partialEpisode = hcm.openEpisode({
    globalOEE: 0.8,
    targetOEE: 0.85,
    criticalACSM: 'acsm2',
  }).episode;
  hcm.registerDecision({ episodeId: partialEpisode.episodeId, targetACSM: 'acsm2' });
  const partial = hcm.registerEffectiveness({
    episodeId: partialEpisode.episodeId,
    beforeGlobalOEE: 0.8,
    afterGlobalOEE: 0.805,
  });
  assert.equal(partial.effectiveness.globalOEEGain, 0.005);
  assert.equal(partial.effectiveness.result, 'partially_effective');

  const ineffectiveEpisode = hcm.openEpisode({
    globalOEE: 0.79,
    targetOEE: 0.85,
    criticalACSM: 'acsm3',
  }).episode;
  hcm.registerDecision({ episodeId: ineffectiveEpisode.episodeId, targetACSM: 'acsm3' });
  const ineffective = hcm.registerEffectiveness({
    episodeId: ineffectiveEpisode.episodeId,
    beforeGlobalOEE: 0.79,
    afterGlobalOEE: 0.78,
  });
  assert.equal(ineffective.effectiveness.globalOEEGain, -0.01);
  assert.equal(ineffective.effectiveness.result, 'ineffective');

  const persisted = readStore();
  assert.equal(persisted.episodes.length, 3);
  assert.equal(persisted.events.length, 6);
  assert.equal(persisted.decisions.length, 3);
  assert.equal(persisted.effectiveness.length, 3);
  assert.equal(hcm.getEpisode(episodeId).episodeId, episodeId);

  const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    storePath,
    `${JSON.stringify(
      {
        episodes: [
          {
            episodeId: 'timeout_without_decision',
            status: 'open',
            startedAt: oldTimestamp,
            closedAt: null,
            trigger: 'global_oee_below_target',
            criticalACSM: 'acsm1',
            globalOEE: 0.7,
            targetOEE: 0.85,
            corporateGoal: null,
            contextSnapshot: {},
          },
          {
            episodeId: 'timeout_with_decision',
            status: 'open',
            startedAt: oldTimestamp,
            closedAt: null,
            trigger: 'global_oee_below_target',
            criticalACSM: 'acsm2',
            globalOEE: 0.7,
            targetOEE: 0.85,
            corporateGoal: null,
            contextSnapshot: {},
          },
        ],
        events: [],
        decisions: [
          {
            decisionId: 'decision_timeout',
            episodeId: 'timeout_with_decision',
            timestamp: oldTimestamp,
            decisionSource: 'supply_chain_coordinator',
            targetACSM: 'acsm2',
            strategy: 'test',
            recommendation: 'test',
            rationale: 'test',
            expectedGain: 0.01,
          },
        ],
        effectiveness: [],
      },
      null,
      2
    )}\n`,
    'utf-8'
  );

  const timeoutEpisodes = hcm.listEpisodes({ timeoutMs: 1 });
  assert.equal(
    timeoutEpisodes.find((episode) => episode.episodeId === 'timeout_without_decision').status,
    'open'
  );
  assert.equal(
    timeoutEpisodes.find((episode) => episode.episodeId === 'timeout_with_decision').status,
    'timeout'
  );

  expectReject(
    () =>
      hcm.registerEvent({
        episodeId: 'missing',
        source: 'acsm1',
        eventType: 'learning',
        content: {},
      }),
    404
  );
  expectReject(
    () =>
      hcm.registerDecision({
        episodeId: 'missing',
        targetACSM: 'acsm1',
      }),
    404
  );
  expectReject(
    () =>
      hcm.registerEffectiveness({
        episodeId: 'missing',
        afterGlobalOEE: 0.8,
      }),
    404
  );
  expectReject(() => hcm.openEpisode({ content: {} }), 422);

  fs.unlinkSync(storePath);
  console.log(
    JSON.stringify(
      {
        ok: true,
        episodeId,
        validated:
          'open -> reuse -> events -> decision -> feedback -> effectiveness -> timeout -> robustness',
      },
      null,
      2
    )
  );
})().catch((error) => {
  try {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  } catch {
    // Best-effort cleanup for the isolated test store.
  }
  console.error(error);
  process.exitCode = 1;
});
