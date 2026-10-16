import http from 'node:http';
import mqtt from 'mqtt';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, validateRuntimeConfig } from './config.js';
import { TOPICS, PPU_TOPIC } from './contracts.js';
import { IngestionService } from './ingestion.js';
import { PersistentSpool } from './spool.js';
import { MySqlRepository } from './repository.js';

export async function startService(config = loadConfig()) {
  validateRuntimeConfig(config);
  if (!config.enableMqtt) throw new Error('MQTT ingestion is disabled. Set PERSISTENCE_ENABLE_MQTT=true only during an approved activation.');

  const poolOptions = { connectionLimit: 1, timezone: 'Z', multipleStatements: false };
  const pool = mysql.createPool(config.mysqlUrl, poolOptions);
  const historyPool = mysql.createPool(config.mysqlUrl, { ...poolOptions, connectionLimit: 4 });
  for (const connectionPool of [pool, historyPool]) connectionPool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  const repository = new MySqlRepository(pool, { historyPool, maxHistoryCursors: 3 });
  const spool = new PersistentSpool(config.spoolPath, config.deadLetterPath);
  await spool.load();
  const ingestion = new IngestionService({ spool, repository, cpsId: config.cpsId, maxEvidenceAgeMs: config.maxEvidenceAgeMs });
  const subscribedTopics = config.enablePpuEvents ? [...TOPICS, PPU_TOPIC] : TOPICS;
  let databaseReady = false;
  const checkDatabase = async () => {
    try {
      await pool.query('SELECT version FROM schema_migrations LIMIT 1');
      databaseReady = true;
      await ingestion.drain();
    } catch (error) {
      databaseReady = false;
      ingestion.lastError = error.code ?? 'database_unavailable';
    }
  };
  void checkDatabase();

  let mqttConnected = false;
  const client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    username: config.mqttUsername,
    password: config.mqttPassword,
    protocolVersion: 5,
    clean: false,
    properties: { sessionExpiryInterval: config.sessionExpirySeconds, receiveMaximum: 10 },
    reconnectPeriod: config.reconnectPeriodMs,
    resubscribe: true,
    customHandleAcks(topic, payload, packet, done) {
      ingestion.accept({ topic, payload, qos: packet.qos, retain: packet.retain })
        .then(() => done(null, 0))
        .catch((error) => done(error));
    },
  });
  client.on('connect', () => {
    mqttConnected = true;
    client.subscribe(subscribedTopics, { qos: 1 }, (error) => { if (error) process.stderr.write(`MQTT subscribe failed: ${error.message}\n`); });
  });
  client.on('reconnect', () => { mqttConnected = false; });
  client.on('close', () => { mqttConnected = false; });
  client.on('error', (error) => process.stderr.write(`MQTT client error: ${error.message}\n`));
  // QoS 0 publications have no ACK callback; enqueue them as a best-effort fallback.
  client.on('message', (topic, payload, packet) => {
    if (packet.qos === 0) void ingestion.accept({ topic, payload, qos: 0, retain: packet.retain });
  });

  const retryTimer = setInterval(() => { void checkDatabase(); }, config.retryPeriodMs);
  retryTimer.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && url.pathname === '/health') {
      const state = ingestion.health();
      const ok = mqttConnected && databaseReady && !state.databaseError;
      res.writeHead(ok ? 200 : 503);
      res.end(JSON.stringify({ service: 'cpslai1-persistence', cpsId: 'cpslai1', mqttConnected, databaseReady, ppuEventsEnabled: config.enablePpuEvents, ...state }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/history/')) {
      try {
        const kind = url.pathname.slice('/v1/history/'.length);
        const rows = await repository.queryHistory(kind, {
          from: url.searchParams.get('from'), to: url.searchParams.get('to'),
          signal: url.searchParams.get('signal'), limit: url.searchParams.get('limit'),
          cursor: url.searchParams.get('cursor'), offset: url.searchParams.get('offset'),
        });
        res.writeHead(200);
        res.end(JSON.stringify({ cpsId: 'cpslai1', kind, ...rows, records: rows.items }));
      } catch (error) {
        const status = error.statusCode ?? (error.message.startsWith('Unsupported') ? 400 : 500);
        res.writeHead(status);
        res.end(JSON.stringify({ error: status === 400 ? error.message : 'history_query_failed' }));
      }
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.httpPort, '127.0.0.1', resolve); });

  return async () => {
    clearInterval(retryTimer);
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => client.end(false, {}, resolve));
    await repository.close();
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startService().then((shutdown) => {
    const stop = () => { shutdown().finally(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
