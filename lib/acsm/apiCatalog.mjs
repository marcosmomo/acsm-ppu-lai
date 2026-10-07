import { getActiveAcsmConfig } from './config.js';

export const AVAILABLE_ACSM_FACADES = Object.freeze([
  Object.freeze({
    phase: 'plug',
    name: 'Plug Services API',
    endpoint: '/api/acsm/plug',
    method: 'GET',
    available: true,
    readOnly: true,
    type: 'phase-service-facade',
    description: 'CPS registration, AAS metadata, discovered capabilities, integration interfaces, Governance profile, and lifecycle evidence.',
  }),
  Object.freeze({
    phase: 'play',
    name: 'Play Services API',
    endpoint: '/api/acsm/play',
    method: 'GET',
    available: true,
    readOnly: true,
    type: 'phase-service-facade',
    description: 'System-level services and analytics for CPS operating in Play.',
  }),
]);

export const LIFECYCLE_OPERATIONS_WITHOUT_FACADE = Object.freeze({
  stop: Object.freeze({
    dedicatedFacade: false,
    reason: 'Operational state within Play; the lifecycle phase remains Play.',
  }),
  maintenance: Object.freeze({
    dedicatedFacade: false,
    reason: 'Maintenance evidence is distributed; no consolidated phase service currently exists.',
  }),
  return: Object.freeze({
    dedicatedFacade: false,
    reason: 'Transitional operation returning the CPS directly to Play.',
  }),
  unplug: Object.freeze({
    dedicatedFacade: false,
    reason: 'Unplug request and result exist, but no consolidated service facade currently exists.',
  }),
});

export function buildAcsmApiCatalog() {
  const acsmConfig = getActiveAcsmConfig();

  return {
    acsmId: acsmConfig.id,
    managedCpsIds: [...acsmConfig.managedCpsIds],
    type: 'api-catalog',
    timestamp: new Date().toISOString(),
    availableFacades: AVAILABLE_ACSM_FACADES.map((facade) => ({ ...facade })),
    lifecycleOperations: Object.fromEntries(
      Object.entries(LIFECYCLE_OPERATIONS_WITHOUT_FACADE).map(([operation, descriptor]) => [
        operation,
        { ...descriptor },
      ])
    ),
  };
}
