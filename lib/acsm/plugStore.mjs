import { buildPlugState } from './plugService.mjs';

const STORE_KEY = Symbol.for('acsm.plug.runtime-store');
const emptySnapshot = { acsmId: 'acsm1', assets: [], operationallyLinked: 0 };
const store = globalThis[STORE_KEY] || { snapshot: emptySnapshot };
globalThis[STORE_KEY] = store;

export const updatePlugSnapshot = (snapshot = {}) => {
  store.snapshot = {
    ...store.snapshot,
    ...snapshot,
    assets: Array.isArray(snapshot.assets) ? snapshot.assets : store.snapshot.assets,
  };
  return buildPlugState(store.snapshot);
};

export const getPlugState = () => buildPlugState(store.snapshot);
