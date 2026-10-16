import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const compose = readFileSync(new URL('docker-compose.yml', root), 'utf8');
const flow = JSON.parse(readFileSync(new URL('node-red/lai/flows/cps-lai-01-synthetic-emulator.json', root), 'utf8'));
const byId = new Map(flow.map((node) => [node.id, node]));

test('normal runtime starts the CPS-LAI-01 cognitive subscriber on the principal broker', () => {
  assert.match(compose, /^  cps-lai-01-cognitive:\s*$/m);
  assert.match(compose, /CPSLAI1_COGNITIVE_ENABLED: "true"/);
  assert.match(compose, /MQTT_URL: mqtt:\/\/acsm-mosquitto:1883/);
  assert.match(compose, /COGNITIVE_OBSERVATION_WINDOW_MS: "3000"/);
  assert.match(compose, /context: \.\/services\/cps-lai-01-cognitive/);
  assert.match(compose, /container_name: acsm-cps-lai-01-cognitive/);
});

test('operational emulator retains nine manual controls, 250 ms clock and 3 second normal cycle', () => {
  const controls = flow.filter((node) => node.type === 'inject' && node.id.startsWith('cpslai1_synthetic_start_'));
  assert.equal(controls.length, 8);
  assert.ok(byId.get('cpslai1_synthetic_stop'));
  const clock = byId.get('cpslai1_synthetic_tick');
  assert.equal(clock.repeat, '0.25');
  assert.equal(clock.once, false);
  assert.match(byId.get('cpslai1_synthetic_generator').func, /normal:\{cycle:3000,/);
});

test('emulator has no dropping Rate Limit and reaches all four operational MQTT outputs', () => {
  const tabId = byId.get('cpslai1_synthetic_tab').id;
  assert.deepEqual(flow.filter((node) => node.z === tabId && node.type === 'delay'), []);
  const adapter = byId.get('cpslai1_operational_contract_adapter');
  assert.deepEqual(adapter.wires.flat(), [
    'cpslai1_synthetic_mqtt_data',
    'cpslai1_synthetic_mqtt_status',
    'cpslai1_synthetic_mqtt_oee',
    'cpslai1_synthetic_mqtt_events',
  ]);
  assert.deepEqual(adapter.wires.flat().map((id) => byId.get(id).topic), [
    'cpslai1/data', 'cpslai1/status', 'cpslai1/oee', 'cpslai1/health',
  ]);
  for (const id of adapter.wires.flat()) {
    const output = byId.get(id);
    assert.equal(output.qos, '1');
    assert.equal(output.broker, 'cpslai1_synthetic_mqtt_broker');
  }
});

test('saved consolidated flow does not masquerade as the operational emulator', () => {
  const consolidated = JSON.parse(readFileSync(new URL('node-red/flows/node-red-lai-2026-10-11.sanitized.json', root), 'utf8'));
  assert.equal(consolidated.some((node) => node.id === 'cpslai1_synthetic_tab'), false);
});
