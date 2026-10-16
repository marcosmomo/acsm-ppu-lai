const positiveInt = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return Object.freeze({
    cpsId: env.CPS_ID || 'cpslai1',
    mqttUrl: env.MQTT_URL || '',
    mqttClientId: env.MQTT_CLIENT_ID || 'cpslai1-persistence',
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    mysqlUrl: env.MYSQL_URL || '',
    spoolPath: env.PERSISTENCE_SPOOL_PATH || './var/pending.jsonl',
    deadLetterPath: env.PERSISTENCE_DEAD_LETTER_PATH || './var/rejected.jsonl',
    sessionExpirySeconds: positiveInt(env.MQTT_SESSION_EXPIRY_SECONDS, 86400),
    reconnectPeriodMs: positiveInt(env.MQTT_RECONNECT_PERIOD_MS, 2000),
    retryPeriodMs: positiveInt(env.PERSISTENCE_RETRY_PERIOD_MS, 3000),
    maxEvidenceAgeMs: positiveInt(env.PERSISTENCE_MAX_EVIDENCE_AGE_MS, 15000),
    httpPort: positiveInt(env.PORT, 3011),
    enableMqtt: env.PERSISTENCE_ENABLE_MQTT === 'true',
    enablePpuEvents: env.PERSISTENCE_ENABLE_PPU_EVENTS === 'true',
  });
}

export function validateRuntimeConfig(config) {
  const missing = ['mqttUrl', 'mysqlUrl'].filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  if (config.cpsId !== 'cpslai1') throw new Error('This service may only own cpslai1 data.');
  let database;
  try { database = new URL(config.mysqlUrl).pathname.replace(/^\//, ''); }
  catch { throw new Error('MYSQL_URL must be a valid URL targeting acsm_cpslai1.'); }
  if (database !== 'acsm_cpslai1') throw new Error('MYSQL_URL must target acsm_cpslai1; central or other CPS databases are forbidden.');
  return config;
}
