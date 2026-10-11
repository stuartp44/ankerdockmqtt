import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runBridge, validateConnection } from "../src/service.js";
import { Dock } from "../src/dock.js";

const env = { MQTT_URL: "mqtt://localhost:1883", POLL_INTERVAL_MS: 1000, HA_DISCOVERY: "false" };

function fakeBroker() {
  const client = new EventEmitter();
  client.connected = true;
  client.publications = [];
  client.publishAsync = async (topic, payload) => client.publications.push({ topic, payload });
  client.endAsync = async () => { client.ended = true; };
  client.subscribe = (_topic, _options, callback) => callback?.(null);
  return client;
}

test("shared service validates CLI and desktop settings identically", () => {
  assert.deepEqual(validateConnection(env), {
    topic: "anker/dock", intervalMs: 1000, discoveryPrefix: "homeassistant", discoveryEnabled: false,
  });
  for (const invalid of [
    {}, { ...env, MQTT_URL: "http://localhost" },
    { ...env, MQTT_TOPIC: "test/+" }, { ...env, POLL_INTERVAL_MS: 999 },
    { ...env, HA_DISCOVERY: "yes" }, { ...env, HA_DISCOVERY_PREFIX: "ha/#" },
  ]) assert.throws(() => validateConnection(invalid));
});

test("service emits live snapshots, publishes availability and closes the dock on stop", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  const snapshot = { timestamp: "2026-10-10", ports: { host: { power_w: 60 } } };
  let closed = false;
  const statuses = [];
  await runBridge({
    env, signal: controller.signal, connect: () => client,
    openDock: async () => ({ snapshot: async () => snapshot, close: async () => { closed = true; } }),
    onState: state => {
      statuses.push(state.status);
      if (state.status === "online") {
        assert.equal(state.snapshot, snapshot);
        controller.abort();
      }
    },
  });
  assert.deepEqual(statuses, ["paused", "online", "stopping", "stopped"]);
  assert.equal(closed, true);
  assert.equal(client.ended, true);
  assert.deepEqual(client.publications.map(item => [item.topic, item.topic.endsWith("/diagnostics") ? "{...}" : item.payload]), [
    ["anker/dock/availability", "offline"],
    ["anker/dock/bridge", "online"],
    ["anker/dock/dock", "connected"],
    ["anker/dock/state", JSON.stringify(snapshot)],
    ["anker/dock/availability", "online"],
    ["anker/dock/diagnostics", "{...}"],
    ["anker/dock/availability", "offline"],
    ["anker/dock/diagnostics", "{...}"],
    ["anker/dock/bridge", "offline"],
  ]);
  const [online, stopped] = client.publications
    .filter(item => item.topic === "anker/dock/diagnostics").map(item => JSON.parse(item.payload));
  assert.equal(online.status, "online");
  assert.equal(online.dock, "connected");
  assert.equal(online.last_error, null);
  assert.ok(online.connected_at && online.last_published_at && online.host);
  assert.equal(stopped.status, "stopped");
});

test("last will reports the laptop offline and timings track broker traffic", async () => {
  let options;
  const { connectBroker } = await import("../src/mqtt.js");
  const client = connectBroker({ MQTT_URL: "mqtt://127.0.0.1:1" }, "anker/dock", () => {});
  options = client.options;
  await client.endAsync(true);
  assert.deepEqual(
    { topic: options.will.topic, payload: options.will.payload.toString(), retain: options.will.retain },
    { topic: "anker/dock/bridge", payload: "offline", retain: true },
  );

  const broker = fakeBroker();
  const controller = new AbortController();
  const states = [];
  await runBridge({
    env, signal: controller.signal, connect: () => broker,
    openDock: async () => ({ snapshot: async () => ({ ports: {} }), close: async () => {} }),
    onState: state => {
      states.push(state);
      if (state.status === "reading") return;
      if (state.status === "online" && states.filter(item => item.status === "online").length === 1) {
        broker.emit("packetreceive", { cmd: "puback" });
        controller.abort();
      }
    },
  });
  const final = states.at(-1);
  assert.ok(final.mqtt.connectedAt);
  assert.ok(final.mqtt.lastPublishedAt);
  assert.ok(final.mqtt.lastReceivedAt, "packet receipt should be recorded");
  assert.equal(states.filter(item => item.status === "online").length, 1, "packets must not re-emit states");
});

test("an unplugged dock publishes disconnected without marking the bridge offline", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  const states = [];
  await runBridge({
    env, signal: controller.signal, connect: () => client,
    openDock: async () => {
      const { DockNotFoundError } = await import("../src/dock.js");
      throw new DockNotFoundError();
    },
    onState: state => {
      states.push(state.status);
      if (state.status === "disconnected") setTimeout(() => controller.abort(), 0);
    },
  });
  assert.ok(states.includes("disconnected"));
  assert.equal(states.includes("error"), false);
  const topics = client.publications.map(item => `${item.topic}=${item.payload}`);
  assert.ok(topics.includes("anker/dock/dock=disconnected"));
  assert.ok(topics.indexOf("anker/dock/bridge=online") < topics.indexOf("anker/dock/dock=disconnected"));
  assert.equal(topics.includes("anker/dock/availability=online"), false);
  const diagnostics = client.publications.filter(item => item.topic === "anker/dock/diagnostics")
    .map(item => JSON.parse(item.payload));
  assert.equal(diagnostics[0].dock, "disconnected");
  assert.match(diagnostics[0].last_error, /not found/);
});

test("USB failure is surfaced, marks offline and closes the failed dock", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  let closed = false;
  await runBridge({
    env, signal: controller.signal, connect: () => client,
    openDock: async () => ({
      snapshot: async () => { throw new Error("Dock unplugged"); },
      close: async () => { closed = true; },
    }),
    onState: state => {
      if (state.status === "error") {
        assert.equal(state.error, "Dock unplugged");
        controller.abort();
      }
    },
  });
  assert.equal(closed, true);
  const topics = client.publications.map(item => `${item.topic}=${item.payload}`);
  assert.ok(topics.includes("anker/dock/dock=error"));
  assert.equal(topics.some(topic => topic.startsWith("anker/dock/state=") || topic === "anker/dock/availability=online"), false);
  assert.equal(client.ended, true);
});

test("MQTT cleanup still runs if HID close fails", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  await assert.rejects(runBridge({
    env, signal: controller.signal, connect: () => client,
    openDock: async () => ({
      snapshot: async () => ({}),
      close: async () => { throw new Error("close failed"); },
    }),
    onState: state => { if (state.status === "online") controller.abort(); },
  }), /close failed/);
  assert.equal(client.ended, true);
  assert.equal(client.publications.at(-1).payload, "offline");
});

test("broker unreachable means zero USB opens or queries; Stop is immediate", async () => {
  const client = fakeBroker();
  client.connected = false;
  const controller = new AbortController();
  let opens = 0;
  const states = [];
  const task = runBridge({
    env, signal: controller.signal, connect: () => client,
    openDock: async () => { opens++; throw new Error("Must not touch USB"); },
    onState: state => states.push(state.status),
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(opens, 0);
  assert.equal(client.publications.length, 0);
  controller.abort();
  await task;
  assert.equal(client.ended, true);
  assert.ok(states.includes("paused"));
});

test("losing broker closes USB and pauses; reconnect reopens and republishes discovery", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  const snapshot = { device: { model: "A83B3", serial: "reconnect-test" }, ports: {} };
  let opens = 0;
  let closes = 0;
  let onlineCount = 0;
  let firstOnline;
  const first = new Promise(resolve => { firstOnline = resolve; });
  const task = runBridge({
    env: { ...env, HA_DISCOVERY: "true", POLL_INTERVAL_MS: 3600000 },
    signal: controller.signal, connect: () => client,
    openDock: async () => {
      opens++;
      return { snapshot: async () => snapshot, close: async () => { closes++; } };
    },
    onState: state => {
      if (state.status === "online") {
        onlineCount++;
        if (onlineCount === 1) firstOnline();
        else controller.abort();
      }
    },
  });
  await first;
  const beforeDisconnect = client.publications.length;
  client.connected = false;
  client.emit("close");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(closes, 1);
  assert.equal(opens, 1);
  assert.equal(client.publications.length, beforeDisconnect);
  client.connected = true;
  client.emit("connect");
  await task;
  assert.equal(opens, 2);
  assert.equal(closes, 2);
  const configs = client.publications.filter(item => item.topic.endsWith("/config"));
  assert.equal(configs.length, 68);
  assert.equal(client.listenerCount("close"), 0);
  assert.equal(client.listenerCount("connect"), 0);
});

test("Home Assistant birth republishes discovery without creating new device identities", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  const snapshot = { device: { model: "A83B3", serial: "birth-test" }, ports: {} };
  let firstOnline;
  const first = new Promise(resolve => { firstOnline = resolve; });
  let reads = 0;
  const task = runBridge({
    env: { ...env, HA_DISCOVERY: "true", POLL_INTERVAL_MS: 3600000 },
    signal: controller.signal, connect: () => client,
    openDock: async () => ({ snapshot: async () => snapshot, close: async () => {} }),
    onState: state => {
      if (state.status === "online" && ++reads === 1) firstOnline();
      else if (state.status === "online") controller.abort();
    },
  });
  await first;
  client.emit("message", "homeassistant/status", Buffer.from("online"));
  await task;
  const configs = client.publications.filter(item => item.topic.endsWith("/config"));
  assert.equal(configs.length, 68);
  assert.deepEqual(configs.slice(0, 34), configs.slice(34));
});

test("broker loss during a real Dock query cancels the pending read and releases USB", { timeout: 3000 }, async () => {
    const client = fakeBroker();
    const controller = new AbortController();
    const device = new EventEmitter();
    let writes = 0;
    let closed;
    const released = new Promise(resolve => { closed = resolve; });
    device.write = async report => {
      writes++;
      queueMicrotask(() => {
        client.connected = false;
        client.emit("close");
      });
      return report.length;
    };
    device.close = async () => closed();
    const dock = new Dock(device, { product: "A83B3" });
    const task = runBridge({
      env, signal: controller.signal, connect: () => client,
      openDock: async () => dock,
    });
    await released;
    assert.equal(writes, 1);
    assert.equal(dock.pending, null);
    assert.equal(dock.closed, true);
    assert.deepEqual(client.publications.map(item => `${item.topic}=${item.payload}`),
      ["anker/dock/availability=offline", "anker/dock/bridge=online"]);
    controller.abort();
    await task;
});

test("unplugged dock retries and resumes after reattachment without restarting bridge", { timeout: 3000 }, async () => {
    const client = fakeBroker();
    const controller = new AbortController();
    let attempts = 0;
    let sawError = false;
    await runBridge({
      env, signal: controller.signal, connect: () => client,
      openDock: async () => {
        if (++attempts === 1) throw new Error("A83B3 not connected");
        return { snapshot: async () => ({}), close: async () => {} };
      },
      onState: state => {
        if (state.status === "error") sawError = true;
        if (state.status === "online") controller.abort();
      },
    });
    assert.equal(sawError, true);
    assert.equal(attempts, 2);
    assert.equal(client.publications.at(-1).payload, "offline");
});

test("connection errors remain visible after the broker closes the socket", async () => {
  const client = fakeBroker();
  client.connected = false;
  const controller = new AbortController();
  let report;
  const states = [];
  const running = runBridge({
    env, signal: controller.signal,
    connect: (_env, _topic, onError) => { report = onError; return client; },
    openDock: async () => { throw new Error("dock must not be opened while disconnected"); },
    onState: state => states.push(state),
  });
  report("MQTT error: Connection refused: Not authorized");
  client.emit("close");
  assert.equal(states.at(-1).status, "paused");
  assert.match(states.at(-1).error, /Not authorized/);
  controller.abort();
  await running;
});

test("Home Assistant birth subscription waits for a connection and cannot hide the real error", async () => {
  const client = fakeBroker();
  client.connected = false;
  let subscriptions = 0;
  client.subscribe = (_topic, _options, callback) => { subscriptions++; callback(new Error("Connection closed")); };
  const controller = new AbortController();
  let report;
  const states = [];
  const running = runBridge({
    env: { ...env, HA_DISCOVERY: "true" }, signal: controller.signal,
    connect: (_env, _topic, onError) => { report = onError; return client; },
    openDock: async () => { throw new Error("dock must not be opened while disconnected"); },
    onState: state => states.push(state),
  });
  try {
    report("MQTT error: connect EHOSTUNREACH");
    client.emit("close");
    assert.equal(subscriptions, 0);
    assert.match(states.at(-1).error, /EHOSTUNREACH/);
    client.emit("connect");
    assert.equal(subscriptions, 1);
  } finally {
    controller.abort();
    await running;
  }
});

test("a dock held by Dock Manager shows busy, stays offline and recovers when released", async () => {
  const client = fakeBroker();
  const controller = new AbortController();
  const snapshot = { timestamp: "2026-10-11", ports: {} };
  let opens = 0;
  const states = [];
  await runBridge({
    env, signal: controller.signal, connect: () => client,
    openDock: async () => {
      opens++;
      if (opens === 1) {
        const error = new Error("hid_open_path: (0xE00002C5) (iokit/common) exclusive access and device already open");
        throw error;
      }
      return { snapshot: async () => snapshot, close: async () => {} };
    },
    onState: state => {
      states.push({ status: state.status, error: state.error });
      if (state.status === "online") controller.abort();
    },
  });
  const busy = states.find(state => state.status === "busy");
  assert.ok(busy, "expected a busy state");
  assert.match(busy.error, /exclusive access/);
  assert.equal(opens, 2);
  assert.equal(states.some(state => state.status === "error"), false);
  const topics = client.publications.map(item => `${item.topic}=${item.payload}`);
  assert.equal(topics.indexOf("anker/dock/availability=offline") < topics.indexOf("anker/dock/availability=online"), true);
});
