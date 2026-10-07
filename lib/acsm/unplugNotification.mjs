export const publishUnplugNotificationIfAvailable = ({
  client,
  topic,
  payload,
  onSkipped = () => {},
}) => {
  if (!client?.connected) {
    onSkipped('MQTT_UNPLUG_NOTIFICATION_SKIPPED_CLIENT_UNAVAILABLE');
    return { published: false, skipped: true };
  }

  try {
    client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false });
    return { published: true, skipped: false };
  } catch (error) {
    onSkipped('MQTT_UNPLUG_NOTIFICATION_SKIPPED_CLIENT_UNAVAILABLE', error);
    return { published: false, skipped: true, error };
  }
};
