import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const plug = fs.readFileSync('components/PlugFase.js', 'utf8');
const demo = fs.readFileSync('components/ExperimentalAasCycleDemo.js', 'utf8');

test('AAS card panel is closed initially and uses only local PlugFase state', () => {
  assert.match(plug, /const \[aasFunctionalCapabilitiesOpen, setAasFunctionalCapabilitiesOpen\] = useState\(false\)/);
  assert.match(plug, /cpslai1' && aasFunctionalCapabilitiesOpen/);
});

test('button opens and closes the panel with the requested labels', () => {
  assert.match(plug, /setAasFunctionalCapabilitiesOpen\(\(open\) => !open\)/);
  assert.match(plug, /View AAS Functional Capabilities/);
  assert.match(plug, /Hide AAS Functional Capabilities/);
});

test('toggle exposes basic disclosure accessibility semantics', () => {
  assert.match(plug, /aria-expanded=\{aasFunctionalCapabilitiesOpen\}/);
  assert.match(plug, /aria-controls="aas-functional-capabilities-panel"/);
  assert.match(plug, /id="aas-functional-capabilities-panel"/);
  assert.match(plug, /type="button"/);
});

test('one experimental demo and one AAS card instance remain', () => {
  assert.equal((plug.match(/<ExperimentalAasCycleDemo/g) || []).length, 1);
  assert.equal((demo.match(/<AasFunctionalCapabilitiesPreview/g) || []).length, 1);
});

test('experimental sequence remains isolated and toggle introduces no PPU side effect', () => {
  assert.match(demo, /Document preview/);
  const sequence = JSON.parse(fs.readFileSync('docs/experiments/cpslai1-three-state-evolution.json', 'utf8'));
  assert.deepEqual(sequence.steps.map(({ label }) => label), ['S1 — Original AAS', 'S2 — Add PieceDetection', 'S3 — Remove PieceDetection']);
  assert.match(demo, /index !== sequenceStep \+ 1/);
  const toggleBlock = plug.slice(plug.indexOf('className="aas-functional-preview-toggle"'), plug.indexOf('</button>', plug.indexOf('className="aas-functional-preview-toggle"')));
  assert.doesNotMatch(toggleBlock, /fetch|plugCPS|unplugCPS|approveGovernanceProfile|playPhaseCPS|Evolution/i);
});
