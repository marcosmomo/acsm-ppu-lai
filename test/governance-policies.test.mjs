import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GOVERNANCE_TEMPLATES,
  buildGovernanceProfile,
  getGovernanceTemplateForCps,
} from '../lib/governance/policies.js';

const expectedLaiTemplates = {
  cpslai1: {
    template: 'DISTRIBUTION_CONVEYOR',
    capability: 'Distribution/Conveyor Station',
    action: 'ADJUST_TRANSPORT_SPEED',
  },
  cpslai2: {
    template: 'JOINING',
    capability: 'Joining Station',
    action: 'ADJUST_JOINING_FORCE',
  },
  cpslai3: {
    template: 'SORTING',
    capability: 'Sorting Station',
    action: 'ADJUST_SORTING_THRESHOLD',
  },
};

for (const [cpsId, expected] of Object.entries(expectedLaiTemplates)) {
  test(`${cpsId} resolves its governance template directly by ID`, () => {
    const template = getGovernanceTemplateForCps(cpsId);

    assert.equal(template, GOVERNANCE_TEMPLATES[cpsId]);
    assert.equal(template.template, expected.template);
    assert.equal(template.capability, expected.capability);
    assert.equal(template.action, expected.action);
  });

  test(`${cpsId} builds a pending governance profile with a governable action`, () => {
    const profile = buildGovernanceProfile(cpsId);

    assert.ok(profile.profileId);
    assert.equal(profile.status, 'PENDING_APPROVAL');
    assert.equal(profile.template, expected.template);
    assert.equal(profile.capability, expected.capability);
    assert.equal(profile.policies.governableActions[0].action, expected.action);
  });
}

test('cpslai1 exposes the required limits and conceptual policies', () => {
  const profile = buildGovernanceProfile('cpslai1');
  const [actionPolicy] = profile.policies.governableActions;

  assert.equal(actionPolicy.policy, 'autonomousAdjustmentLimit');
  assert.equal(actionPolicy.autonomousLimit, 10);
  assert.equal(actionPolicy.humanApprovalLimit, 20);
  assert.deepEqual(
    {
      telemetry: profile.policies.telemetry,
      health: profile.policies.health,
      oee: profile.policies.oee,
      recommendation: profile.policies.recommendation,
      maintenanceRequest: profile.policies.maintenanceRequest,
    },
    {
      telemetry: 'REQUIRED',
      health: 'REQUIRED',
      oee: 'REQUIRED',
      recommendation: 'ALLOW',
      maintenanceRequest: 'ALLOW',
    }
  );
});
