import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Dock, isDockBusyError, isDockMissingError } from "./dock.js";
import {
  connectBroker, publishAvailability, publishBridge, publishDiagnostics, publishDockConnection, publishSnapshot,
  publishDiscovery,
} from "./mqtt.js";

function dockConnectionFor(error) {
  if (isDockBusyError(error)) return "busy";
  if (isDockMissingError(error)) return "disconnected";
  return "error";
}

export function validateConnection(env) {
  const intervalMs = Number(env.POLL_INTERVAL_MS ?? 10000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) {
    throw new Error("POLL_INTERVAL_MS must be an integer between 1000 and 3600000");
  }
  const topic = env.MQTT_TOPIC ?? "anker/dock";
  if (!topic || /[+#\0]/.test(topic) || topic.endsWith("/")) {
    throw new Error("MQTT_TOPIC must be a nonempty topic prefix without wildcards or a trailing slash");
  }
  if (!env.MQTT_URL) throw new Error("Set MQTT_URL, or use --once without a broker");
  const url = new URL(env.MQTT_URL);
  if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("MQTT_URL must use mqtt, mqtts, ws, or wss");
  }
  const discoveryPrefix = env.HA_DISCOVERY_PREFIX ?? "homeassistant";
  if (!discoveryPrefix || /[+#\0]/.test(discoveryPrefix) || discoveryPrefix.endsWith("/")) {
    throw new Error("HA_DISCOVERY_PREFIX must be a nonempty prefix without wildcards or a trailing slash");
  }
  if (env.HA_DISCOVERY !== undefined && !["true", "false"].includes(env.HA_DISCOVERY)) {
    throw new Error("HA_DISCOVERY must be true or false");
  }
  return { topic, intervalMs, discoveryPrefix, discoveryEnabled: env.HA_DISCOVERY !== "false" };
}

export async function runBridge({
  env,
  signal,
  onState = () => {},
  openDock = Dock.open,
  connect = connectBroker,
}) {
  const { intervalMs, topic, discoveryPrefix, discoveryEnabled } = validateConnection(env);
  if (signal.aborted) return;
  // Timings change on every broker packet; they ride along with the next state update instead of emitting their own.
  const timing = { connectedAt: null, lastPublishedAt: null, lastReceivedAt: null };
  let state = { status: "paused", snapshot: null, error: null, dock: null, mqtt: { ...timing } };
  const update = patch => {
    state = { ...state, ...patch, mqtt: { ...timing } };
    onState(state);
  };
  const client = connect(env, topic, error => {
    update({ status: "paused", error });
    console.error(error);
  });
  let dock;
  let needsOffline = true;
  let needsBridge = true;
  let publishedDock = null;
  let needsDiscovery = discoveryEnabled;
  let discoveryGeneration = 0;
  let connectionGeneration = 0;
  let poll;
  let sleeper;
  const wake = () => sleeper?.abort();
  const cancelPoll = () => poll?.abort();
  const subscribeBirth = () => {
    if (!discoveryEnabled) return;
    client.subscribe(`${discoveryPrefix}/status`, { qos: 1 }, error => {
      if (error && client.connected) {
        console.error(`Home Assistant birth subscription failed: ${error.message}`);
        update({ error: error.message });
      }
    });
  };
  const onConnect = () => {
    subscribeBirth();
    connectionGeneration++;
    needsOffline = true;
    needsBridge = true;
    publishedDock = null;
    needsDiscovery = discoveryEnabled;
    discoveryGeneration++;
    timing.connectedAt = new Date().toISOString();
    update({ status: "reading", error: null });
    wake();
  };
  const onDisconnect = () => {
    connectionGeneration++;
    needsOffline = true;
    needsBridge = true;
    publishedDock = null;
    needsDiscovery = discoveryEnabled;
    cancelPoll();
    timing.connectedAt = null;
    update({ status: "paused" });
    wake();
  };
  const onPacket = () => { timing.lastReceivedAt = new Date().toISOString(); };
  const setDockConnection = async value => {
    state = { ...state, dock: value };
    if (publishedDock === value || !client.connected) return;
    await publishDockConnection(client, topic, value);
    publishedDock = value;
  };
  const host = hostname();
  const sendDiagnostics = async ({ status = state.status, error = state.error } = {}) => {
    if (!client.connected) return;
    await publishDiagnostics(client, topic, {
      host,
      status,
      dock: state.dock,
      connected_at: timing.connectedAt,
      last_published_at: timing.lastPublishedAt,
      last_broker_message_at: timing.lastReceivedAt,
      last_error: error,
      updated_at: new Date().toISOString(),
    });
  };
  const onMessage = (messageTopic, payload) => {
    if (messageTopic === `${discoveryPrefix}/status` && payload.toString() === "online") {
      needsDiscovery = discoveryEnabled;
      discoveryGeneration++;
      wake();
    }
  };
  const onStop = () => { cancelPoll(); wake(); };
  update({});
  client.on("connect", onConnect);
  client.on("close", onDisconnect);
  client.on("offline", onDisconnect);
  client.on("message", onMessage);
  client.on("packetreceive", onPacket);
  signal.addEventListener("abort", onStop, { once: true });
  if (client.connected) {
    subscribeBirth();
    timing.connectedAt = new Date().toISOString();
  }
  const closeDock = async () => {
    if (!dock) return;
    const closing = dock;
    dock = undefined;
    await closing.close();
  };
  try {
    while (!signal.aborted) {
      try {
        if (client.connected) {
          if (needsOffline) {
            await publishAvailability(client, topic, "offline");
            needsOffline = false;
          }
          if (needsBridge) {
            await publishBridge(client, topic, "online");
            needsBridge = false;
          }
          if (!client.connected || signal.aborted) continue;
          const generation = connectionGeneration;
          poll = new AbortController();
          dock ??= await openDock(env.DOCK_SERIAL);
          const shouldQuery = () => client.connected && generation === connectionGeneration && !signal.aborted;
          if (!shouldQuery()) {
            await closeDock();
            continue;
          }
          const snapshot = await dock.snapshot({ signal: poll.signal, shouldQuery });
          if (shouldQuery()) {
            if (needsDiscovery) {
              const discoveryAtStart = discoveryGeneration;
              await publishDiscovery(client, topic, snapshot, discoveryPrefix);
              if (discoveryAtStart === discoveryGeneration) needsDiscovery = false;
            }
            if (!shouldQuery()) continue;
            await setDockConnection("connected");
            await publishSnapshot(client, topic, snapshot);
            if (shouldQuery()) {
              timing.lastPublishedAt = new Date().toISOString();
              await sendDiagnostics({ status: "online", error: null });
            }
            if (shouldQuery()) update({ status: "online", snapshot, error: null });
          }
        } else {
          await closeDock();
        }
      } catch (error) {
        const dockFailure = !signal.aborted && client.connected && !poll?.signal.aborted;
        if (dockFailure && isDockBusyError(error)) {
          if (state.status !== "busy") console.error(`Dock busy: ${error.message}`);
          update({ status: "busy", error: error.message, dock: "busy" });
        } else if (dockFailure && isDockMissingError(error)) {
          if (state.status !== "disconnected") console.error(`Dock disconnected: ${error.message}`);
          update({ status: "disconnected", error: error.message, dock: "disconnected" });
        } else if (dockFailure) {
          console.error(`Bridge error: ${error.message}`);
          update({ status: "error", error: error.message, dock: "error" });
        } else if (!signal.aborted) {
          update({ status: "paused" });
        }
        await closeDock();
        needsOffline = true;
        needsDiscovery = discoveryEnabled;
        if (client.connected) {
          try {
            await publishAvailability(client, topic, "offline");
            needsOffline = false;
            if (dockFailure) {
              await setDockConnection(dockConnectionFor(error));
              await sendDiagnostics();
            }
          } catch (publishError) {
            console.error(`Failed to publish offline status: ${publishError.message}`);
            update({ status: "error", error: publishError.message });
          }
        }
      } finally {
        poll = undefined;
        if (!client.connected) await closeDock();
      }
      sleeper = new AbortController();
      if (signal.aborted) break;
      try {
        await delay(intervalMs, undefined, { signal: sleeper.signal });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      } finally {
        sleeper = undefined;
      }
    }
  } finally {
    update({ status: "stopping" });
    signal.removeEventListener("abort", onStop);
    client.removeListener("connect", onConnect);
    client.removeListener("close", onDisconnect);
    client.removeListener("offline", onDisconnect);
    client.removeListener("message", onMessage);
    client.removeListener("packetreceive", onPacket);
    try {
      await closeDock();
    } finally {
      try {
        if (client.connected) {
          await publishAvailability(client, topic, "offline");
          await sendDiagnostics({ status: "stopped" });
          await publishBridge(client, topic, "offline");
        }
      } finally {
        await client.endAsync(true);
        update({ status: "stopped" });
      }
    }
  }
}
