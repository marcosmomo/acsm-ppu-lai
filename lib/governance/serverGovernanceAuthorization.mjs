export const GOVERNANCE_PERMISSIONS = Object.freeze({
  PROFILE_APPROVE: 'governance.profile.approve',
  PROFILE_REJECT: 'governance.profile.reject',
  POLICY_UPDATE: 'governance.policy.update',
  ACTION_APPROVE: 'governance.action.approve',
  ACTION_REJECT: 'governance.action.reject',
  CYCLE_RECONCILE: 'governance.cycle.reconcile',
  LOCK_RELEASE: 'governance.lock.release',
  MANUAL_PLUG: 'governance.lifecycle.plug',
  MANUAL_UNPLUG: 'governance.lifecycle.unplug',
});

export const GOVERNANCE_ROLES = Object.freeze({
  OPERATOR: 'GOVERNANCE_OPERATOR',
  ADMIN: 'GOVERNANCE_ADMIN',
  LIFECYCLE_OPERATOR: 'LIFECYCLE_OPERATOR',
});

export const DEFAULT_GOVERNANCE_ROLE_POLICY = Object.freeze({
  [GOVERNANCE_PERMISSIONS.PROFILE_APPROVE]: Object.freeze([GOVERNANCE_ROLES.OPERATOR]),
  [GOVERNANCE_PERMISSIONS.PROFILE_REJECT]: Object.freeze([GOVERNANCE_ROLES.OPERATOR]),
  [GOVERNANCE_PERMISSIONS.POLICY_UPDATE]: Object.freeze([GOVERNANCE_ROLES.ADMIN]),
  [GOVERNANCE_PERMISSIONS.ACTION_APPROVE]: Object.freeze([GOVERNANCE_ROLES.OPERATOR]),
  [GOVERNANCE_PERMISSIONS.ACTION_REJECT]: Object.freeze([GOVERNANCE_ROLES.OPERATOR]),
  [GOVERNANCE_PERMISSIONS.CYCLE_RECONCILE]: Object.freeze([GOVERNANCE_ROLES.ADMIN]),
  [GOVERNANCE_PERMISSIONS.LOCK_RELEASE]: Object.freeze([GOVERNANCE_ROLES.ADMIN]),
  [GOVERNANCE_PERMISSIONS.MANUAL_PLUG]: Object.freeze([GOVERNANCE_ROLES.LIFECYCLE_OPERATOR]),
  [GOVERNANCE_PERMISSIONS.MANUAL_UNPLUG]: Object.freeze([GOVERNANCE_ROLES.LIFECYCLE_OPERATOR]),
});

export const GOVERNANCE_AUTHORIZATION_MATRIX = Object.freeze([
  Object.freeze({ operation: 'PROFILE_APPROVE', path: 'app/api/governance/cps/[cpsId]/approve/route.js', permission: GOVERNANCE_PERMISSIONS.PROFILE_APPROVE, principal: 'HUMAN' }),
  Object.freeze({ operation: 'PROFILE_REJECT', path: 'app/api/governance/cps/[cpsId]/reject/route.js', permission: GOVERNANCE_PERMISSIONS.PROFILE_REJECT, principal: 'HUMAN' }),
  Object.freeze({ operation: 'POLICY_UPDATE', path: 'app/api/governance/cps/[cpsId]/route.js', permission: GOVERNANCE_PERMISSIONS.POLICY_UPDATE, principal: 'HUMAN' }),
  Object.freeze({ operation: 'ACTION_APPROVE', path: 'app/api/governance/action/[actionId]/approve/route.js', permission: GOVERNANCE_PERMISSIONS.ACTION_APPROVE, principal: 'HUMAN' }),
  Object.freeze({ operation: 'ACTION_REJECT', path: 'app/api/governance/action/[actionId]/reject/route.js', permission: GOVERNANCE_PERMISSIONS.ACTION_REJECT, principal: 'HUMAN' }),
  Object.freeze({ operation: 'CYCLE_RECONCILE', path: null, permission: GOVERNANCE_PERMISSIONS.CYCLE_RECONCILE, principal: 'HUMAN_ADMIN', status: 'NOT_IMPLEMENTED' }),
  Object.freeze({ operation: 'LOCK_RELEASE', path: null, permission: GOVERNANCE_PERMISSIONS.LOCK_RELEASE, principal: 'HUMAN_ADMIN', status: 'NOT_IMPLEMENTED' }),
  Object.freeze({ operation: 'MANUAL_PLUG', path: 'app/api/acsm/plug/route.js', permission: GOVERNANCE_PERMISSIONS.MANUAL_PLUG, principal: 'LIFECYCLE_OPERATOR' }),
  Object.freeze({ operation: 'MANUAL_UNPLUG', path: 'app/api/acsm/plug/route.js', permission: GOVERNANCE_PERMISSIONS.MANUAL_UNPLUG, principal: 'LIFECYCLE_OPERATOR' }),
]);

function authorizationError(code, message, status, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = { code, ...details };
  return error;
}

const text = (value) => String(value || '').trim();

function validDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeRolePolicy(rolePolicy) {
  const entries = Object.entries(rolePolicy || {});
  if (!entries.length) throw authorizationError('GOVERNANCE_ROLE_POLICY_REQUIRED', 'An explicit governance role policy is required.', 500);
  return Object.freeze(Object.fromEntries(entries.map(([permission, roles]) => {
    if (!text(permission) || !Array.isArray(roles) || roles.length === 0 || roles.some((role) => !text(role))) {
      throw authorizationError('GOVERNANCE_ROLE_POLICY_INVALID', 'Every permission requires at least one role.', 500, { permission });
    }
    return [permission, Object.freeze([...new Set(roles.map(text))])];
  })));
}

/**
 * Boundary adapter for a future real server identity provider. The resolver is
 * responsible for cryptographic/session verification. Request body fields are
 * never read here and cannot become identity or roles.
 */
export function createServerGovernanceAuthorization({
  resolveServerIdentity,
  rolePolicy = DEFAULT_GOVERNANCE_ROLE_POLICY,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof resolveServerIdentity !== 'function') {
    throw authorizationError('GOVERNANCE_SERVER_IDENTITY_RESOLVER_REQUIRED', 'A server-side authenticated identity resolver is required.', 500);
  }
  const policy = normalizeRolePolicy(rolePolicy);

  return Object.freeze({
    async authorize(request, permission) {
      const requiredPermission = text(permission);
      const allowedRoles = policy[requiredPermission];
      if (!allowedRoles) {
        throw authorizationError('GOVERNANCE_PERMISSION_UNKNOWN', 'Permission is not present in the server authorization policy.', 403, { permission: requiredPermission });
      }

      const identity = await resolveServerIdentity(request);
      if (!identity || identity.authenticated !== true) {
        throw authorizationError('GOVERNANCE_AUTHENTICATION_REQUIRED', 'A valid server-authenticated session is required.', 401);
      }
      if (identity.verifiedByServer !== true || identity.source !== 'SERVER_SESSION') {
        throw authorizationError('GOVERNANCE_SERVER_IDENTITY_UNTRUSTED', 'Identity was not verified by the configured server provider.', 401);
      }

      const subject = text(identity.subject);
      const authenticationId = text(identity.authenticationId);
      const authenticatedAt = text(identity.authenticatedAt);
      const expiresAt = text(identity.expiresAt);
      const roles = Array.isArray(identity.roles) ? [...new Set(identity.roles.map(text).filter(Boolean))] : [];
      const authenticatedTimestamp = validDate(authenticatedAt);
      const expirationTimestamp = validDate(expiresAt);
      const nowTimestamp = validDate(now());

      if (!subject || !authenticationId || authenticatedTimestamp === null || expirationTimestamp === null || nowTimestamp === null) {
        throw authorizationError('GOVERNANCE_SERVER_SESSION_INVALID', 'Authenticated server session is structurally invalid.', 401);
      }
      if (authenticatedTimestamp > nowTimestamp || expirationTimestamp <= nowTimestamp) {
        throw authorizationError('GOVERNANCE_SERVER_SESSION_EXPIRED', 'Authenticated server session is expired or not yet valid.', 401);
      }
      if (!allowedRoles.some((role) => roles.includes(role))) {
        throw authorizationError('GOVERNANCE_PERMISSION_DENIED', 'Authenticated subject lacks the required governance role.', 403, {
          permission: requiredPermission,
          requiredRoles: [...allowedRoles],
        });
      }

      return Object.freeze({
        subject,
        authenticationId,
        authenticatedAt,
        roles: Object.freeze(roles),
        provenance: 'SERVER_AUTHENTICATION',
        authenticated: true,
        authorized: true,
        trusted: true,
        permission: requiredPermission,
      });
    },
  });
}
