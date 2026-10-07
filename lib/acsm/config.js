const DEFAULT_ACSM_ID = 'acsm1';

export const ACSM_ID = DEFAULT_ACSM_ID;

export const MANAGED_CPS_BY_ACSM = {
  acsm1: ['cpslai1', 'cpslai2', 'cpslai3'],
};

export const MANAGED_CPS_IDS = MANAGED_CPS_BY_ACSM[ACSM_ID] || [];
export const RESERVED_CPS_IDS = [];

export const CPS_DISPLAY_NAME_BY_ID = {
  cpslai2: 'CPS-LAI-02 – Joining Station',
  cpslai1: 'CPS-LAI-01 – Distribution/Conveyor Station',
  cpslai3: 'CPS-LAI-03 – Sorting Station',
};

export const ACSM_CONFIGS = {
  acsm1: {
    id: 'acsm1',
    code: 'ACSM-PPU-LAI',
    name: 'ACSM-PPU-LAI',
    shortName: 'ACSM-PPU-LAI',
    industryId: 'industry1',
    industryName: 'Industry 1',
    description:
      'Variante experimental para integracao dos CPS fisicos CPS-LAI-01, CPS-LAI-02 e CPS-LAI-03 do LAI.',
    managedCpsIds: MANAGED_CPS_BY_ACSM.acsm1,
    allowedCpsIds: MANAGED_CPS_BY_ACSM.acsm1,
    defaultCpsId: 'cpslai1',
    mqttNamespace: 'acsm1',
    topics: {
      wildcardOee: 'acsm1/+/oee',
      wildcardLearning: 'acsm1/+/learning',
      globalOee: 'acsm1/global/oee',
      globalReasoning: 'acsm1/global/reasoning',
      globalLearning: 'acsm1/global/learning',
      level2Intelligence: 'acsm1/level2/intelligence',
      lifecycleUnplugRequest: 'acsm1/lifecycle/unplug_request',
      lifecycleUpdateFunctions: 'acsm1/lifecycle/update_functions',
      knowledgeGlobal: 'acsm1/level2/intelligence',
    },
    externalApis: {
      brokerApiBasePath: '/api/acsm1',
    },
    report: {
      fileSlug: 'acsm-1',
      displayName: 'ACSM-1',
      architectureName: 'ACSM-1 - Architecture of Control for Smart Manufacturing',
    },
  },
};

export const normalizeCpsId = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  const cleaned = raw.replace(/[^a-z0-9]/g, '');
  const match = cleaned.match(/^([a-z]+)0*([0-9]+)$/);

  if (match) return `${match[1]}${match[2]}`;
  return cleaned;
};

export const getAcsmConfig = (acsmId) => {
  const normalizedId = String(acsmId || DEFAULT_ACSM_ID).toLowerCase().trim();
  return ACSM_CONFIGS[normalizedId] || ACSM_CONFIGS[DEFAULT_ACSM_ID];
};

export const getActiveAcsmId = (explicitId) =>
  String(explicitId || process.env.NEXT_PUBLIC_ACSM_ID || process.env.ACSM_ID || DEFAULT_ACSM_ID)
    .toLowerCase()
    .trim();

export const getActiveAcsmConfig = (explicitId) =>
  getAcsmConfig(getActiveAcsmId(explicitId));

export const getManagedCpsIdsForAcsm = (acsmIdOrConfig) => {
  const acsmId =
    typeof acsmIdOrConfig === 'string'
      ? acsmIdOrConfig
      : acsmIdOrConfig?.id || getActiveAcsmId();

  const normalizedAcsmId = String(acsmId || DEFAULT_ACSM_ID).toLowerCase().trim();
  const configured = MANAGED_CPS_BY_ACSM[normalizedAcsmId];
  const fallback = Array.isArray(acsmIdOrConfig?.managedCpsIds)
    ? acsmIdOrConfig.managedCpsIds
    : getAcsmConfig(normalizedAcsmId).managedCpsIds;

  return (configured || fallback || []).map((id) => normalizeCpsId(id)).filter(Boolean);
};

export const getDefaultCpsIdForAcsm = (acsmId) =>
  getAcsmConfig(acsmId).defaultCpsId;

export const isCpsManagedByAcsm = (acsmIdOrConfig, cpsId) => {
  const normalizedCpsId = normalizeCpsId(cpsId);
  return getManagedCpsIdsForAcsm(acsmIdOrConfig).includes(normalizedCpsId);
};

export const isManagedCps = (cpsId, acsmIdOrConfig = getActiveAcsmConfig()) =>
  isCpsManagedByAcsm(acsmIdOrConfig, cpsId);

export const keepManagedValue = (value, acsmIdOrConfig = getActiveAcsmConfig()) => {
  const normalized = normalizeCpsId(value);
  return isManagedCps(normalized, acsmIdOrConfig) ? normalized : null;
};

const getAasSpecificAssetValue = (aas, name) => {
  const items = aas?.assetInformation?.specificAssetIds || [];
  const match = items.find(
    (item) => String(item?.name || '').toLowerCase() === String(name || '').toLowerCase()
  );
  return match?.value ?? null;
};

const getCpsIdFromDisplaySource = (source) => {
  if (!source || typeof source !== 'object') return normalizeCpsId(source);

  const aas = Array.isArray(source?.assetAdministrationShells)
    ? source.assetAdministrationShells[0]
    : source?.assetAdministrationShells?.[0] || null;

  return normalizeCpsId(
    source?.cpsId ||
      source?.id ||
      source?.baseTopic ||
      source?.topic ||
      source?.cps ||
      getAasSpecificAssetValue(aas, 'cpsId') ||
      getAasSpecificAssetValue(aas, 'baseTopic') ||
      aas?.idShort ||
      aas?.id
  );
};

const getCpsNameFromDisplaySource = (source) => {
  if (!source || typeof source !== 'object') return '';

  const aas = Array.isArray(source?.assetAdministrationShells)
    ? source.assetAdministrationShells[0]
    : source?.assetAdministrationShells?.[0] || null;

  return (
    source?.cpsName ||
    source?.name ||
    source?.nome ||
    source?.assetName ||
    source?.displayName ||
    source?.lifecycle?.cpsName ||
    getAasSpecificAssetValue(aas, 'assetName') ||
    ''
  );
};

const isCanonicalDisplayName = (name, cpsId) => {
  const text = String(name || '').trim();
  if (!text) return false;
  return normalizeCpsId(text) !== normalizeCpsId(cpsId);
};

export const buildCpsDisplayNameMap = (sources = []) => {
  const map = { ...CPS_DISPLAY_NAME_BY_ID };
  const list = Array.isArray(sources) ? sources : Object.values(sources || {});

  list.forEach((source) => {
    const cpsId = getCpsIdFromDisplaySource(source);
    const name = getCpsNameFromDisplaySource(source);
    if (cpsId && isCanonicalDisplayName(name, cpsId)) {
      map[cpsId] = String(name).trim();
    }
  });

  return map;
};

export const resolveCpsDisplayName = (cpsId, sources = [], fallbackName = '') => {
  const normalizedId = normalizeCpsId(cpsId);
  if (!normalizedId) return String(fallbackName || '').trim();

  if (isCanonicalDisplayName(fallbackName, normalizedId)) {
    return String(fallbackName).trim();
  }

  const nameMap = buildCpsDisplayNameMap(sources);
  return nameMap[normalizedId] || normalizedId;
};

export const filterContributionRanking = (
  ranking,
  acsmIdOrConfig = getActiveAcsmConfig(),
  displayNameSources = []
) => {
  if (!Array.isArray(ranking)) return [];

  return ranking
    .filter((item) => {
      const id = item?.cpsId || item?.id || item?.baseTopic || item?.cps || '';
      return isManagedCps(id, acsmIdOrConfig);
    })
    .map((item) => {
      const normalizedId = keepManagedValue(
        item?.cpsId || item?.id || item?.baseTopic || item?.cps,
        acsmIdOrConfig
      );

      return normalizedId
        ? {
            ...item,
            cpsId: normalizedId,
            cpsName: resolveCpsDisplayName(
              normalizedId,
              displayNameSources,
              item?.cpsName || item?.name
            ),
          }
        : item;
    });
};

const extractCpsTokens = (value) => String(value || '').match(/cps[\s_-]*0*\d+/gi) || [];

export const filterManagedArrayByCps = (arr, acsmIdOrConfig = getActiveAcsmConfig()) => {
  if (!Array.isArray(arr)) return [];

  return arr.filter((item) => {
    if (typeof item === 'string') {
      const ids = extractCpsTokens(item);
      if (!ids.length) return true;
      return ids.every((id) => isManagedCps(id, acsmIdOrConfig));
    }

    const ids = [
      item?.cpsId,
      item?.id,
      item?.baseTopic,
      item?.sourceCps,
      item?.targetCps,
      ...(Array.isArray(item?.relatedCps) ? item.relatedCps : [item?.relatedCps]),
    ]
      .map((id) => normalizeCpsId(id))
      .filter(Boolean);

    if (!ids.length) return true;
    return ids.every((id) => isManagedCps(id, acsmIdOrConfig));
  });
};

export const extractCpsIdFromAas = (parsed) => {
  const aas = Array.isArray(parsed?.assetAdministrationShells)
    ? parsed.assetAdministrationShells[0]
    : null;

  const rawId =
    getAasSpecificAssetValue(aas, 'cpsId') ||
    aas?.idShort ||
    aas?.id ||
    parsed?.cpsId ||
    '';

  return normalizeCpsId(rawId);
};
