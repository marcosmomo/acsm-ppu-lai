import { buildPlayState } from './playService.mjs';

const STORE_KEY = Symbol.for('acsm.play.runtime-store');

const emptySnapshot = { acsmId: 'acsm1', cps: [], totalCps: 1, analytics: {}, historySize: 0 };

const store = globalThis[STORE_KEY] || { snapshot: emptySnapshot };
globalThis[STORE_KEY] = store;

export const updatePlaySnapshot = (snapshot = {}) => {
  store.snapshot = {
    ...store.snapshot,
    ...snapshot,
    cps: Array.isArray(snapshot.cps) ? snapshot.cps : store.snapshot.cps,
    analytics: snapshot.analytics && typeof snapshot.analytics === 'object'
      ? snapshot.analytics
      : store.snapshot.analytics,
  };
  return buildPlayState(store.snapshot);
};

export const getPlayState = () => buildPlayState(store.snapshot);
