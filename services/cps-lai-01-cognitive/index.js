import mqtt from 'mqtt';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CognitiveAnalysis } from './cognitiveAnalysis.js';
import { INPUT_TOPICS, OUTPUT_TOPIC, parseMqttPayload } from './contracts.js';

const enabled = (value) => String(value || '').trim().toLowerCase() === 'true';

export function loadConfig(env = process.env) {
  return {
    enabled: enabled(env.CPSLAI1_COGNITIVE_ENABLED),
    mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    clientId: env.MQTT_CLIENT_ID || 'cpslai1-cognitive',
    minimumSamples: Number(env.COGNITIVE_MINIMUM_SAMPLES || 5),
    maxSamples: Number(env.COGNITIVE_MAX_SAMPLES || 30),
    bucketMs: Number(env.COGNITIVE_OBSERVATION_WINDOW_MS || 60000),
    horizonMs: Number(env.COGNITIVE_PREDICTION_HORIZON_MS || 300000),
    publicationIntervalMs: Number(env.COGNITIVE_PUBLICATION_INTERVAL_MS || 30000),
    hysteresisConfirmations: Number(env.COGNITIVE_HYSTERESIS_CONFIRMATIONS || 2),
    historyBaseUrl: String(env.CPSLAI1_HISTORY_BASE_URL || '').replace(/\/$/, ''),
  };
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rounded = (value) => Number.isFinite(value) ? Number(value.toFixed(3)) : value;

export function semanticFingerprint(envelope) {
  return hash({
    patterns: [...(envelope.learning?.patterns || [])].sort(),
    dominantPattern: envelope.learning?.dominantPattern ?? null,
    risk: envelope.reasoning?.riskLevel ?? null,
    dominantLoss: envelope.reasoning?.dominantLoss ?? null,
    recommendation: envelope.recommendation?.category ?? envelope.recommendation?.text ?? null,
  });
}

function contentFingerprint(envelope) {
  return hash({
    semantic: semanticFingerprint(envelope),
    indicators: Object.fromEntries(Object.entries(envelope.sourceMetadata?.latestIndicators || {}).map(([key, value]) => [key, rounded(value)])),
    prediction: Object.fromEntries(Object.entries(envelope.prediction?.expected || {}).map(([key, value]) => [key, rounded(value)])),
  });
}

export class PublicationController {
  constructor({ minimumIntervalMs = 30000 } = {}) { this.minimumIntervalMs = minimumIntervalMs; this.lastPublishedAt = null; this.lastSemantic = null; this.lastContent = null; }
  shouldPublish(envelope, nowMs = Date.now()) {
    const semantic = semanticFingerprint(envelope); const content = contentFingerprint(envelope);
    if (this.lastPublishedAt === null) return this.accept(semantic, content, nowMs, 'baseline');
    if (semantic !== this.lastSemantic) return this.accept(semantic, content, nowMs, 'significant_change');
    if (content === this.lastContent) return { publish: false, reason: 'semantic_duplicate', semanticFingerprint: semantic };
    if (nowMs - this.lastPublishedAt < this.minimumIntervalMs) return { publish: false, reason: 'minimum_interval', semanticFingerprint: semantic };
    return this.accept(semantic, content, nowMs, 'interval_elapsed');
  }
  accept(semantic, content, nowMs, reason) { this.lastSemantic = semantic; this.lastContent = content; this.lastPublishedAt = nowMs; return { publish: true, reason, semanticFingerprint: semantic }; }
}

async function readHistory(config, kind) {
  if (!config.historyBaseUrl) return [];
  const response = await fetch(`${config.historyBaseUrl}/v1/history/${kind}?limit=${config.maxSamples}`);
  if (!response.ok) throw new Error(`History ${kind} returned HTTP ${response.status}.`);
  const body = await response.json();
  return Array.isArray(body.items) ? [...body.items].reverse() : [];
}

export async function preloadHistory(analysis, config) {
  const [oee, ppu] = await Promise.all([readHistory(config, 'oee'), readHistory(config, 'ppu')]);
  for (const event of ppu) {
    const payload = event.payload_json && typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json || event;
    if (payload?.cpsId === 'cpslai1') analysis.ingestPpuEvent(payload);
  }
  for (const row of oee) {
    const payload = row.payload_json && typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    if (payload?.cpsId === 'cpslai1') analysis.ingest('cpslai1/oee', payload);
  }
}

export async function startService(config = loadConfig(), dependencies = {}) {
  if (!config.enabled) throw new Error('CPS-LAI-01 cognitive service is disabled. Set CPSLAI1_COGNITIVE_ENABLED=true only for an approved experiment.');
  const connect = dependencies.mqttConnect || mqtt.connect;
  const analysis = dependencies.analysis || new CognitiveAnalysis(config);
  const publication = dependencies.publication || new PublicationController({ minimumIntervalMs: config.publicationIntervalMs });
  await preloadHistory(analysis, config);
  const client = connect(config.mqttUrl, {
    clientId: config.clientId, username: config.mqttUsername, password: config.mqttPassword,
    reconnectPeriod: 5000, clean: true,
  });
  client.on('connect', () => client.subscribe(INPUT_TOPICS, { qos: 1 }));
  client.on('message', async (topic, bytes) => {
    try {
      const envelope = analysis.ingest(topic, parseMqttPayload(bytes));
      if (topic !== 'cpslai1/oee') return;
      const decision = publication.shouldPublish(envelope);
      if (!decision.publish) return;
      client.publish(OUTPUT_TOPIC, JSON.stringify(envelope), { qos: 1, retain: false });
    } catch (error) {
      console.error(`[COGNITIVE_INPUT_REJECTED] ${topic}: ${error.message}`);
    }
  });
  return async () => new Promise((resolve) => client.end(false, {}, resolve));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startService().catch((error) => {
    console.error(`[COGNITIVE_START_ERROR] ${error.message}`);
    process.exitCode = 1;
  });
}
