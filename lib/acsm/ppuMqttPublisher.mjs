import { isPpuOutboxEntryDue } from './ppuOutbox.mjs';

export const PPU_MQTT_PUBLISH_FLAG = 'PPU_MQTT_PUBLISH_ENABLED';

export const isPpuMqttPublishingEnabled = (env = process.env) =>
  String(env?.[PPU_MQTT_PUBLISH_FLAG] || '').trim().toLowerCase() === 'true';

const publish = (client, topic, payload) => new Promise((resolve, reject) => {
  client.publish(topic, payload, { qos: 1, retain: false }, (error) => error ? reject(error) : resolve());
});

export async function publishPendingPpuEvents({
  client,
  repository,
  enabled = isPpuMqttPublishingEnabled(),
  now = new Date(),
  maxAttempts = 5,
  retryDelayMs = 30_000,
} = {}) {
  if (!enabled) return { enabled: false, attempted: 0, published: 0, failed: 0 };
  if (!client?.publish) throw new Error('An injected MQTT client is required.');
  if (!repository?.list || !repository?.markPublished || !repository?.markFailed) {
    throw new Error('A PPU outbox repository is required.');
  }

  const due = (await repository.list()).filter((entry) =>
    isPpuOutboxEntryDue(entry, { now, maxAttempts })
  );
  const result = { enabled: true, attempted: 0, published: 0, failed: 0 };
  for (const entry of due) {
    result.attempted += 1;
    try {
      await publish(client, entry.topic, JSON.stringify(entry.payload));
      await repository.markPublished(entry.eventId, { now });
      result.published += 1;
    } catch (error) {
      await repository.markFailed(entry.eventId, error, { now, retryDelayMs });
      result.failed += 1;
    }
  }
  return result;
}
