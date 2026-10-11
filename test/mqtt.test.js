import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import createAedes from "aedes";
import mqtt from "mqtt";
import { connectBroker, publishSnapshot, publishAvailability, describeMqttError } from "../src/mqtt.js";

test("broker configuration fails explicitly for missing or unsupported URLs", () => {
  assert.throws(() => connectBroker({}, "test"), /Set MQTT_URL/);
  assert.throws(() => connectBroker({ MQTT_URL: "http://localhost" }, "test"), /must use/);
});

test("Aedes test broker factory remains compatible with the integration tests", async t => {
  const broker = createAedes();
  t.after(() => new Promise(resolve => broker.close(resolve)));
  assert.equal(typeof broker.handle, "function");
});

test("disconnected broker or lost acknowledgement fails rather than hanging or publishing online", async () => {
  await assert.rejects(publishSnapshot({ connected: false }, "test", {}), /disconnected/);
  const client = new EventEmitter();
  client.connected = true;
  const topics = [];
  client.publishAsync = async topic => {
    topics.push(topic);
    queueMicrotask(() => client.emit("close"));
    return new Promise(() => {});
  };
  await assert.rejects(publishSnapshot(client, "test", {}), /before publication/);
  assert.deepEqual(topics, ["test/state"]);
  assert.equal(client.listenerCount("close"), 0);
});

test("real broker receives retained state, online status, late subscription and graceful offline", async t => {
  const broker = createAedes();
  const server = createServer(broker.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `mqtt://127.0.0.1:${server.address().port}`;
  const publisher = connectBroker({ MQTT_URL: url }, "test/dock", () => {});
  await once(publisher, "connect");
  t.after(async () => {
    await publisher.endAsync(true);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const snapshot = {
    timestamp: "2026-10-10T19:00:00.000Z",
    device: { model: "A83B3" },
    ports: { host: { voltage_v: 20, current_a: 3, power_w: 60 } },
  };
  await publishSnapshot(publisher, "test/dock", snapshot);
  const subscriber = mqtt.connect(url);
  t.after(() => subscriber.endAsync(true));
  await once(subscriber, "connect");
  const retained = new Map();
  const messages = new Promise(resolve => {
    subscriber.on("message", (topic, payload, packet) => {
      retained.set(topic, { payload: payload.toString(), retained: packet.retain });
      if (retained.size === 2) resolve();
    });
  });
  await subscriber.subscribeAsync("test/dock/#", { qos: 1 });
  await messages;
  assert.deepEqual(JSON.parse(retained.get("test/dock/state").payload), snapshot);
  assert.equal(retained.get("test/dock/state").retained, true);
  assert.equal(retained.get("test/dock/availability").payload, "online");
  assert.equal(retained.get("test/dock/availability").retained, true);
  const offline = once(subscriber, "message");
  await publishAvailability(publisher, "test/dock", "offline");
  const [topic, payload] = await offline;
  assert.equal(topic, "test/dock/availability");
  assert.equal(payload.toString(), "offline");
  await subscriber.endAsync(true);
});

test("explains macOS Local Network blocks on unreachable brokers", () => {
  const error = Object.assign(new Error("connect EHOSTUNREACH 192.168.1.5:1883"), { code: "EHOSTUNREACH" });
  assert.match(describeMqttError(error, "darwin"), /Privacy & Security > Local Network/);
  assert.equal(describeMqttError(error, "win32"), error.message);
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(describeMqttError(refused, "darwin"), refused.message);
});

test("explains rejected MQTT credentials", () => {
  const error = Object.assign(new Error("Connection refused: Not authorized"), { code: 5 });
  assert.match(describeMqttError(error, "darwin"), /rejected the username or password/);
});
