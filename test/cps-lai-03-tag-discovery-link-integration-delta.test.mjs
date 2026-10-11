import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deltaPath = path.join(root, 'node-red/lai/flows/cps-lai-03-tag-discovery-link-integration-delta.json');
const operationalPath = path.join(root, 'node-red/lai/flows/cps-lai-03-opcua-mqtt.json');
const specialistPath = path.join(root, 'node-red/lai/flows/cps-lai-03-opcua-tag-discovery.json');
const delta = JSON.parse(fs.readFileSync(deltaPath, 'utf8'));
const operational = JSON.parse(fs.readFileSync(operationalPath, 'utf8'));
const specialist = JSON.parse(fs.readFileSync(specialistPath, 'utf8'));

test('incremental delta contains only Link In and Link Out and references the existing READ client', () => {
  assert.equal(delta.length, 2);
  const input = delta.find(node => node.type === 'link in');
  const output = delta.find(node => node.type === 'link out');
  assert.equal(input.id, 'cpslai3_tag_discovery_in');
  assert.equal(input.z, 'c3a0000000000001');
  assert.deepEqual(input.wires, [['c3a0000000000005']]);
  assert.equal(output.id, 'cpslai3_tag_discovery_return');
  assert.equal(output.z, input.z);
  assert.equal(output.mode, 'return');
  assert.deepEqual(output.wires, []);
  assert.ok(delta.every(node => ['link in', 'link out'].includes(node.type)));
});

test('Link Call target and local response-router pattern are exclusive to tagged discovery messages', () => {
  const linkCall = specialist.find(node => node.type === 'link call');
  assert.deepEqual(linkCall.links, ['cpslai3_tag_discovery_in']);
  const client = operational.find(node => node.id === 'c3a0000000000005');
  assert.equal(client.type, 'OpcUa-Client');
  assert.equal(client.action, 'info');
  assert.equal(operational.filter(node => node.type === 'OpcUa-Client').length, 1);
  const router = operational.find(node => node.id === 'c3a000000000001b');
  assert.equal(router.outputs, 5);
  assert.deepEqual(new Function('msg', router.func)({ _tagDiscovery: true }), [null, null, null, null, { _tagDiscovery: true }]);
  assert.deepEqual(new Function('msg', router.func)({ _experimental: true }), [null, { _experimental: true }, null, null, null]);
  assert.deepEqual(router.wires[4], [outputId()]);
});

function outputId() {
  return delta.find(node => node.type === 'link out').id;
}
