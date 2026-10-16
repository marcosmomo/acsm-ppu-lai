import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GOVERNANCE_AUTHORIZATION_MATRIX,
  GOVERNANCE_PERMISSIONS,
  GOVERNANCE_ROLES,
  createServerGovernanceAuthorization,
} from '../lib/governance/serverGovernanceAuthorization.mjs';
import { buildHumanDecisionCommand } from '../lib/governance/cutoverIntegrationContracts.mjs';

const now = () => '2026-10-14T20:00:00.000Z';
const operatorIdentity = (overrides = {}) => ({
  authenticated: true,
  verifiedByServer: true,
  source: 'SERVER_SESSION',
  subject: 'operator-from-server-session',
  authenticationId: 'session-test-001',
  authenticatedAt: '2026-10-14T19:00:00.000Z',
  expiresAt: '2026-10-14T21:00:00.000Z',
  roles: [GOVERNANCE_ROLES.OPERATOR],
  ...overrides,
});

const adapter = (identity) => createServerGovernanceAuthorization({ resolveServerIdentity: async () => identity, now });

test('unauthenticated request is rejected with HTTP 401 semantics', async () => {
  await assert.rejects(() => adapter(null).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE), { code: 'GOVERNANCE_AUTHENTICATION_REQUIRED', status: 401 });
});

test('authenticated identity without server verification is rejected', async () => {
  await assert.rejects(() => adapter(operatorIdentity({ verifiedByServer: false })).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE), { code: 'GOVERNANCE_SERVER_IDENTITY_UNTRUSTED', status: 401 });
});

test('authenticated operator receives the exact trusted context contract', async () => {
  const context = await adapter(operatorIdentity()).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE);
  assert.deepEqual(context, {
    subject: 'operator-from-server-session', authenticationId: 'session-test-001',
    authenticatedAt: '2026-10-14T19:00:00.000Z', roles: ['GOVERNANCE_OPERATOR'],
    provenance: 'SERVER_AUTHENTICATION', authenticated: true, authorized: true, trusted: true,
    permission: GOVERNANCE_PERMISSIONS.PROFILE_APPROVE,
  });
});

test('insufficient role and authenticated-but-unauthorized operation return HTTP 403 semantics', async () => {
  await assert.rejects(
    () => adapter(operatorIdentity()).authorize({}, GOVERNANCE_PERMISSIONS.POLICY_UPDATE),
    { code: 'GOVERNANCE_PERMISSION_DENIED', status: 403 }
  );
  const admin = adapter(operatorIdentity({ roles: [GOVERNANCE_ROLES.ADMIN] }));
  const context = await admin.authorize({}, GOVERNANCE_PERMISSIONS.POLICY_UPDATE);
  assert.equal(context.authorized, true);
});

test('expired, future and malformed sessions are rejected', async () => {
  await assert.rejects(() => adapter(operatorIdentity({ expiresAt: '2026-10-14T20:00:00.000Z' })).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE), { code: 'GOVERNANCE_SERVER_SESSION_EXPIRED' });
  await assert.rejects(() => adapter(operatorIdentity({ authenticatedAt: '2026-10-14T20:01:00.000Z' })).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE), { code: 'GOVERNANCE_SERVER_SESSION_EXPIRED' });
  await assert.rejects(() => adapter(operatorIdentity({ authenticationId: '' })).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE), { code: 'GOVERNANCE_SERVER_SESSION_INVALID' });
});

test('spoofed frontend body cannot define subject, roles or authentication metadata', async () => {
  const request = { body: { subject: 'attacker', approvedBy: 'attacker', roles: [GOVERNANCE_ROLES.ADMIN], authenticated: true } };
  const resolver = async () => operatorIdentity();
  const context = await createServerGovernanceAuthorization({ resolveServerIdentity: resolver, now })
    .authorize(request, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE);
  assert.equal(context.subject, 'operator-from-server-session');
  assert.deepEqual(context.roles, [GOVERNANCE_ROLES.OPERATOR]);
});

test('authentication produces actor context but never performs or infers a human decision', async () => {
  const context = await adapter(operatorIdentity()).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE);
  assert.equal('decision' in context, false);
  assert.throws(() => buildHumanDecisionCommand({
    cpsId: 'cpslai1', plugCycleId: 'cycle-current', profileId: 'profile-obsolete',
    expectedRevision: 3, authorization: context,
  }), { code: 'GOVERNANCE_INTEGRATION_FIELD_REQUIRED' });
  const command = buildHumanDecisionCommand({
    cpsId: 'cpslai1', plugCycleId: 'cycle-current', profileId: 'profile-current',
    expectedRevision: 3, authorization: context, decision: 'APPROVED',
  });
  assert.equal(command.decision, 'APPROVED');
  assert.equal(command.profileId, 'profile-current');
  assert.equal(command.authorization.permission, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE);
  assert.throws(() => buildHumanDecisionCommand({
    cpsId: 'cpslai1', plugCycleId: 'cycle-current', profileId: 'profile-current',
    expectedRevision: 3, authorization: context, decision: 'DENIED',
  }), { code: 'GOVERNANCE_TRUSTED_SERVER_AUTHORIZATION_REQUIRED' });
});

test('decision permission is bound to the exact requested decision and cycle/profile target', async () => {
  const context = await adapter(operatorIdentity()).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE);
  const command = buildHumanDecisionCommand({
    cpsId: 'cpslai2', plugCycleId: 'cycle-2', profileId: 'profile-2',
    expectedRevision: 9, authorization: context, decision: 'APPROVED',
  });
  assert.deepEqual(
    { cpsId: command.cpsId, plugCycleId: command.plugCycleId, profileId: command.profileId, decision: command.decision },
    { cpsId: 'cpslai2', plugCycleId: 'cycle-2', profileId: 'profile-2', decision: 'APPROVED' },
  );
  const rejectContext = await adapter(operatorIdentity()).authorize({}, GOVERNANCE_PERMISSIONS.PROFILE_REJECT);
  assert.throws(() => buildHumanDecisionCommand({
    cpsId: 'cpslai2', plugCycleId: 'cycle-2', profileId: 'profile-2',
    expectedRevision: 9, authorization: rejectContext, decision: 'APPROVED',
  }), { code: 'GOVERNANCE_TRUSTED_SERVER_AUTHORIZATION_REQUIRED' });
});

test('authorization matrix covers decisions, policies, admin reconciliation, locks and lifecycle', () => {
  const operations = new Set(GOVERNANCE_AUTHORIZATION_MATRIX.map((entry) => entry.operation));
  for (const required of ['PROFILE_APPROVE', 'PROFILE_REJECT', 'POLICY_UPDATE', 'ACTION_APPROVE', 'ACTION_REJECT', 'CYCLE_RECONCILE', 'LOCK_RELEASE', 'MANUAL_PLUG', 'MANUAL_UNPLUG']) {
    assert.equal(operations.has(required), true, required);
  }
  assert.equal(GOVERNANCE_AUTHORIZATION_MATRIX.find((entry) => entry.operation === 'LOCK_RELEASE').status, 'NOT_IMPLEMENTED');
});

test('current application has no reusable application authentication or session dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const packageName of ['next-auth', '@auth/core', 'better-auth', '@clerk/nextjs', '@auth0/nextjs-auth0', '@descope/nextjs-sdk']) {
    assert.equal(packageName in dependencies, false, packageName);
  }
  for (const file of ['middleware.js', 'middleware.ts', 'proxy.js', 'proxy.ts']) assert.equal(fs.existsSync(path.resolve(file)), false, file);
});

test('operational routes still consume informative frontend actor fields and were not modified', () => {
  const cases = [
    ['app/api/governance/cps/[cpsId]/approve/route.js', 'approvedBy'],
    ['app/api/governance/cps/[cpsId]/reject/route.js', 'rejectedBy'],
    ['app/api/governance/cps/[cpsId]/route.js', 'updatedBy'],
    ['app/api/governance/action/[actionId]/approve/route.js', 'approvedBy'],
    ['app/api/governance/action/[actionId]/reject/route.js', 'rejectedBy'],
  ];
  for (const [file, marker] of cases) assert.match(fs.readFileSync(path.resolve(file), 'utf8'), new RegExp(`body\\?\\.${marker}`));
});

test('isolated adapter has no operational Store, network, credential or decision side effect', () => {
  const source = fs.readFileSync(path.resolve('lib/governance/serverGovernanceAuthorization.mjs'), 'utf8').toLowerCase();
  for (const forbidden of ['governancestore', 'fetch(', 'axios', 'mqtt', 'opcua', 'localhost', 'password', 'clientsecret', 'approveprofile(', 'rejectprofile(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
