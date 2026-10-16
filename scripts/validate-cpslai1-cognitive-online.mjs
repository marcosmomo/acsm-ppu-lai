import mqtt from 'mqtt';
import { loadConfig, startService } from '../services/cps-lai-01-cognitive/index.js';
import { assertCognitiveEnvelope, normalizeOeePayload } from '../services/cps-lai-01-cognitive/contracts.js';

const mqttUrl = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const timeoutMs = Number(process.env.CPSLAI1_ONLINE_VALIDATION_TIMEOUT_MS || 30000);
const observed = { oee: null, learning: null };

const observer = mqtt.connect(mqttUrl, {
  clientId: `cpslai1-cognitive-validation-${Date.now()}`,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 5000,
});

const connected = new Promise((resolve, reject) => {
  observer.once('connect', resolve);
  observer.once('error', reject);
});

await connected;
await new Promise((resolve, reject) => {
  observer.subscribe(['cpslai1/oee', 'acsm/cpslai1/learning'], { qos: 1 }, (error) =>
    error ? reject(error) : resolve()
  );
});

observer.on('message', (topic, bytes) => {
  try {
    const payload = JSON.parse(bytes.toString('utf8'));
    if (topic === 'cpslai1/oee') observed.oee = normalizeOeePayload(payload);
    if (topic === 'acsm/cpslai1/learning') observed.learning = assertCognitiveEnvelope(payload);
  } catch (error) {
    process.stderr.write(`[ONLINE_VALIDATION_REJECTED] ${topic}: ${error.message}\n`);
  }
});

const stopService = await startService({
  ...loadConfig({
    CPSLAI1_COGNITIVE_ENABLED: 'true',
    MQTT_URL: mqttUrl,
    MQTT_CLIENT_ID: `cpslai1-cognitive-validation-service-${Date.now()}`,
    COGNITIVE_OBSERVATION_WINDOW_MS: '3000',
    COGNITIVE_PUBLICATION_INTERVAL_MS: '0',
  }),
  enabled: true,
  historyBaseUrl: '',
});

const cognitiveReady = () =>
  observed.learning?.learning?.ready === true &&
  observed.learning?.reasoning?.state === 'available' &&
  observed.learning?.prediction?.state === 'generated' &&
  observed.learning?.recommendation?.state === 'generated';

const deadline = Date.now() + timeoutMs;
while ((!observed.oee || !cognitiveReady()) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

await stopService();
await new Promise((resolve) => observer.end(true, {}, resolve));

if (!observed.oee) throw new Error(`No cpslai1/oee received within ${timeoutMs} ms.`);
if (!observed.learning) throw new Error(`No acsm/cpslai1/learning received within ${timeoutMs} ms.`);
if (!cognitiveReady()) {
  throw new Error(`Cognitive output did not reach Learning/Reasoning/Prediction/Recommendation readiness within ${timeoutMs} ms.`);
}

process.stdout.write(JSON.stringify({
  ok: true,
  mqttUrl,
  oeeTimestamp: observed.oee.timestamp,
  learningTimestamp: observed.learning.timestamp,
  learningState: observed.learning.learning.state,
  reasoningState: observed.learning.reasoning.state,
  predictionState: observed.learning.prediction.state,
  recommendationState: observed.learning.recommendation.state,
}) + '\n');
