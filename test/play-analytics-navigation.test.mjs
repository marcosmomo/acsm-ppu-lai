import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildCpsAnalyticsHref } from '../lib/acsm/analyticsNavigation.mjs';

const playSource = readFileSync(new URL('../components/PlayFase.js', import.meta.url), 'utf8');
const analyticsRouteSource = readFileSync(new URL('../app/analytics/page.js', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../app/layout.js', import.meta.url), 'utf8');
const contextSource = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');

test('Analytics navigation binds the selected CPS id and name to the individual dashboard URL', () => {
  const href = buildCpsAnalyticsHref({
    id: 'cpslai1',
    nome: 'CPS-LAI-01 - Distribution/Conveyor Station',
  });
  const url = new URL(href, 'http://localhost:3000');

  assert.equal(url.pathname, '/analytics');
  assert.equal(url.searchParams.get('cpsId'), 'cpslai1');
  assert.equal(url.searchParams.get('cpsName'), 'CPS-LAI-01 - Distribution/Conveyor Station');
});

test('Analytics navigation preserves the selected CPS for all Play cards', () => {
  assert.equal(buildCpsAnalyticsHref({ cpsId: 'CPS-LAI-02' }), '/analytics?cpsId=cpslai2');
  assert.equal(buildCpsAnalyticsHref({ topic: 'cpslai3/data' }), '/analytics?cpsId=cpslai3');
  assert.equal(buildCpsAnalyticsHref({}), null);
});

test('every Play card state uses Next Link to preserve the in-memory CPS provider', () => {
  const bindings = playSource.match(/<Link\s+href=\{analyticsHref\}/g) || [];
  assert.equal(bindings.length, 3);
  assert.match(playSource, /import Link from 'next\/link'/);
  assert.doesNotMatch(playSource, /onClick=\{\(\) => openAnalyticsPage\(router, cps\)\}/);
  assert.doesNotMatch(playSource, /<a\s+href=\{analyticsHref/);
  assert.match(playSource, /const analyticsHref = buildCpsAnalyticsHref\(cps\)/);
});

test('the Analytics route reads and validates the cpsId query parameter', () => {
  assert.match(analyticsRouteSource, /searchParams\.get\('cpsId'\)/);
  assert.match(analyticsRouteSource, /allowedCpsIds\.includes\(normalizedRequestedId\)/);
  assert.match(analyticsRouteSource, /<CPSAnalyticsFromContext cpsId=\{cpsId\}/);
});

test('client-side Analytics navigation preserves the root CPSProvider state', () => {
  assert.match(layoutSource, /<CPSProvider>[\s\S]*?\{children\}[\s\S]*?<\/CPSProvider>/);
  assert.match(contextSource, /const \[cpsAnalytics, setCpsAnalyticsState\] = useState\(\{\}\)/);
  assert.match(contextSource, /const playPhaseCPS = useMemo\(\(\) => addedCPS\.filter\(isCpsInPlay\)/);
  assert.match(playSource, /<Link\s+href=\{analyticsHref\}/);
  assert.doesNotMatch(playSource, /<a\s+href=\{analyticsHref/);
});
