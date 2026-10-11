import mqtt from "mqtt";
import { discoveryMessages } from "./discovery.js";

export function connectBroker(env, topic, log = console.error) {
  if (!env.MQTT_URL) throw new Error("Set MQTT_URL, or use --once without a broker");
  const url = new URL(env.MQTT_URL);
  if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("MQTT_URL must use mqtt, mqtts, ws, or wss");
  }
  const client = mqtt.connect(env.MQTT_URL, {
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    clientId: env.MQTT_CLIENT_ID || `anker-dock-${process.pid}`,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    keepalive: 10,
    queueQoSZero: false,
    // The broker publishes this if the laptop vanishes (sleep, network loss, crash) without a clean disconnect.
    will: { topic: `${topic}/bridge`, payload: "offline", qos: 1, retain: true },
  });
  client.on("error", error => log(`MQTT error: ${describeMqttError(error)}`));
  return client;
}

const LOCAL_NETWORK_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "EPERM", "EACCES"]);

export function describeMqttError(error, platform = process.platform) {
  if (platform === "darwin" && LOCAL_NETWORK_CODES.has(error.code)) {
    return `${error.message}. macOS may be blocking Local Network access: enable Dock MQTT in System Settings > Privacy & Security > Local Network, then restart the bridge`;
  }
  if (error.code === 5 || error.code === 4 || error.code === 135 || error.code === 134) {
    return `${error.message}. The broker rejected the username or password; check the account on the broker (Home Assistant's Mosquitto add-on accepts Home Assistant users or its configured logins)`;
  }
  return error.message;
}

async function publish(client, topic, payload) {
  if (!client.connected) throw new Error("MQTT broker is disconnected");
  let timer;
  let onClose;
  const disconnected = new Promise((_, reject) => {
    onClose = () => reject(new Error("MQTT disconnected before publication was acknowledged"));
    client.once("close", onClose);
    timer = setTimeout(() => reject(new Error("MQTT publication acknowledgement timed out")), 10000);
  });
  try {
    await Promise.race([
      client.publishAsync(topic, payload, { qos: 1, retain: true }),
      disconnected,
    ]);
  } finally {
    clearTimeout(timer);
    client.removeListener("close", onClose);
  }
}

export async function publishAvailability(client, topic, value) {
  await publish(client, `${topic}/availability`, value);
}

export async function publishBridge(client, topic, value) {
  await publish(client, `${topic}/bridge`, value);
}

export async function publishDockConnection(client, topic, value) {
  await publish(client, `${topic}/dock`, value);
}

export async function publishDiagnostics(client, topic, diagnostics) {
  await publish(client, `${topic}/diagnostics`, JSON.stringify(diagnostics));
}

export async function publishSnapshot(client, topic, snapshot) {
  await publish(client, `${topic}/state`, JSON.stringify(snapshot));
  await publishAvailability(client, topic, "online");
}

export async function publishDiscovery(client, topic, snapshot, prefix) {
  for (const message of discoveryMessages(snapshot, topic, prefix)) {
    await publish(client, message.topic, JSON.stringify(message.payload));
  }
}
