const mqtt = require('mqtt');

const timeoutMs = Number(process.env.MQTT_VALIDATION_TIMEOUT_MS || 12000);
const brokerUrl = process.env.MQTT_VALIDATION_URL || 'mqtt://127.0.0.1:1883';
const topics = ['cpslai1/#', 'cpslai2/#', 'cpslai3/#'];
const seen = new Map();
const client = mqtt.connect(brokerUrl, {
  clientId: `acsm_final_validation_${Date.now()}`,
  clean: true,
  connectTimeout: 3000,
});

client.on('connect', () => {
  client.subscribe(topics, { qos: 0 }, (error) => {
    if (error) {
      console.error(`MQTT subscription failed: ${error.message}`);
      process.exitCode = 2;
    }
  });
});

client.on('message', (topic, buffer) => {
  let payload;
  try {
    payload = JSON.parse(buffer.toString('utf8'));
  } catch {
    payload = buffer.toString('utf8');
  }
  seen.set(topic, {
    topic,
    cpsId: payload?.cpsId ?? null,
    calculationState: payload?.calculationState ?? null,
    indicatorClass: payload?.indicatorClass ?? null,
    operationalState: payload?.operationalState ?? null,
    currentMode: payload?.currentMode ?? payload?.derived?.operationMode ?? null,
    healthState: payload?.health?.healthState ?? payload?.healthState ?? null,
    oee: payload?.oee?.current ?? null,
    availability: payload?.oee?.availability ?? null,
    performance: payload?.oee?.performance ?? null,
    quality: payload?.oee?.quality ?? null,
    evidenceStatus: payload?.evidenceStatus ?? null,
    timestamp:
      payload?.publishedAt ?? payload?.timestamp ?? payload?.calculatedAt ?? null,
  });
});

client.on('error', (error) => {
  console.error(`MQTT connection failed: ${error.message}`);
});

setTimeout(() => {
  console.log(JSON.stringify([...seen.values()].sort((a, b) =>
    a.topic.localeCompare(b.topic)), null, 2));
  client.end(true, () => process.exit(seen.size ? (process.exitCode || 0) : 3));
}, timeoutMs);
