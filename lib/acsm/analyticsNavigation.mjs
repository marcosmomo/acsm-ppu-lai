import { normalizeCpsId } from './config.js';

export const buildCpsAnalyticsHref = (cps) => {
  const topicCpsId = String(cps?.topic || '').split('/')[0];
  const rawId = cps?.id || cps?.cpsId || cps?.baseTopic || cps?.cps || topicCpsId;
  const cpsId = normalizeCpsId(rawId);

  if (!cpsId) return null;

  const params = new URLSearchParams({ cpsId });
  const cpsName = cps?.nome || cps?.name;
  if (cpsName) params.set('cpsName', String(cpsName));

  return `/analytics?${params.toString()}`;
};
