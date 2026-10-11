import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import createAedes from "aedes";
import mqtt from "mqtt";
import { discoveryMessages } from "../src/discovery.js";
import { connectBroker, publishDiscovery } from "../src/mqtt.js";

const snapshot = { device: { model: "A83B3", serial: "00000000050C" }, ports: {} };

const BRIDGE_KEYS = ["bridge_connected", "dock_connection", "last_update", "bridge_connected_since",
  "last_broker_message", "bridge_status", "last_error"];

test("HA discovery produces 34 stable entities grouped as one device with availability", () => {
  const configs = discoveryMessages(snapshot, "anker/dock");
  assert.equal(configs.length, 34);
  assert.equal(new Set(configs.map(message => message.payload.unique_id)).size, 34);
  assert.equal(new Set(configs.map(message => message.payload.device.identifiers[0])).size, 1);
  for (const { topic, payload } of configs) {
    assert.match(topic, /^homeassistant\/(sensor|binary_sensor)\/anker_a83b3_[a-f0-9]+\/\w+\/config$/);
    assert.equal(payload.device.manufacturer, "Anker");
    assert.equal(payload.device.serial_number, snapshot.device.serial);
    assert.equal("command_topic" in payload, false);
    if (BRIDGE_KEYS.some(key => payload.unique_id.endsWith(`_${key}`))) continue;
    assert.equal(payload.state_topic, "anker/dock/state");
    assert.deepEqual(payload.availability, [
      { topic: "anker/dock/bridge" }, { topic: "anker/dock/availability" },
    ]);
    assert.equal(payload.availability_mode, "all");
    assert.equal(payload.payload_available, "online");
    assert.equal(payload.payload_not_available, "offline");
    assert.ok(payload.value_template.startsWith("{{"));
  }
  const power = configs.find(message => message.payload.name === "Laptop power").payload;
  assert.equal(power.value_template, "{{ value_json.ports.host.power_w }}");
  assert.equal(power.unit_of_measurement, "W");
  assert.equal(power.device_class, "power");
  assert.equal(power.state_class, "measurement");
  const bandwidth = configs.find(message => message.payload.name === "Ethernet link speed").payload;
  assert.equal("state_class" in bandwidth, false);
});

test("bridge last will and diagnostics stay visible when the laptop disconnects", () => {
  const configs = discoveryMessages(snapshot, "anker/dock");
  const byKey = key => configs.find(message => message.payload.unique_id.endsWith(`_${key}`)).payload;
  const bridge = byKey("bridge_connected");
  assert.equal(bridge.state_topic, "anker/dock/bridge");
  assert.equal(bridge.payload_on, "online");
  assert.equal(bridge.payload_off, "offline");
  assert.equal(bridge.device_class, "connectivity");
  assert.equal("availability" in bridge || "availability_topic" in bridge, false);
  const dock = byKey("dock_connection");
  assert.equal(dock.state_topic, "anker/dock/dock");
  assert.deepEqual(dock.options, ["Connected", "Unplugged", "In use by another app", "Error"]);
  assert.match(dock.value_template, /"connected":"Connected"/);
  assert.equal(dock.availability_topic, "anker/dock/bridge");
  for (const key of ["last_update", "bridge_connected_since", "last_broker_message", "bridge_status", "last_error"]) {
    const entity = byKey(key);
    assert.equal(entity.entity_category, "diagnostic");
    assert.equal("availability" in entity || "availability_topic" in entity, false, key);
  }
  assert.equal(byKey("last_broker_message").state_topic, "anker/dock/diagnostics");
  assert.equal(byKey("last_broker_message").device_class, "timestamp");
  assert.equal(byKey("last_update").value_template, "{{ value_json.timestamp }}");
});

test("entities without a device class get a specific icon instead of Home Assistant's generic eye", () => {
  for (const { payload } of discoveryMessages(snapshot, "anker/dock")) {
    const generic = !payload.device_class || payload.device_class === "connectivity" || payload.device_class === "enum";
    if (generic) assert.match(payload.icon ?? "", /^mdi:[a-z-]+$/, payload.name);
  }
});

test("identities survive topic changes and new sessions; different serials stay separate", () => {
  const original = discoveryMessages(snapshot, "original");
  const changed = discoveryMessages(snapshot, "new", "custom_ha");
  assert.equal(original[0].payload.unique_id, changed[0].payload.unique_id);
  assert.equal(changed[0].payload.state_topic, "new/state");
  assert.ok(changed[0].topic.startsWith("custom_ha/"));
  assert.notEqual(original[0].payload.unique_id,
    discoveryMessages({ device: { model: "A83B3", serial: "another" } }, "original")[0].payload.unique_id);
  assert.equal(discoveryMessages({ device: { model: "A83B3" } }, "fallback")[0].payload.unique_id,
    discoveryMessages({ device: { model: "A83B3" } }, "fallback")[0].payload.unique_id);
  assert.throws(() => discoveryMessages({}, "test"), /identity/);
});

test("all discovery configs arrive retained via actual MQTT broker for late HA subscribers", async t => {
  const broker = createAedes();
  const server = createServer(broker.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `mqtt://127.0.0.1:${server.address().port}`;
  const publisher = connectBroker({ MQTT_URL: url }, "anker/dock", () => {});
  await once(publisher, "connect");
  let subscriber;
  t.after(async () => {
    if (subscriber) await subscriber.endAsync(true);
    await publisher.endAsync(true);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  await publishDiscovery(publisher, "anker/dock", snapshot, "homeassistant");
  subscriber = mqtt.connect(url);
  await once(subscriber, "connect");
  const received = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  subscriber.on("message", (topic, payload, packet) => {
    received.push({ topic, payload: JSON.parse(payload), retained: packet.retain });
    if (received.length === 34) complete();
  });
  await subscriber.subscribeAsync("homeassistant/#");
  await done;
  assert.ok(received.every(message => message.retained));
  assert.deepEqual(received.map(message => message.topic).sort(),
    discoveryMessages(snapshot, "anker/dock").map(message => message.topic).sort());
});
