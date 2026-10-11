import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, normalizeSettings, settingsEnv, SettingsStore } from "../desktop/settings.js";

const valid = {
  ...DEFAULT_SETTINGS,
  brokerUrl: "mqtts://broker.example:8883",
  username: "test",
  password: "secret-test-value",
  clearPassword: false,
};
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a),
  decryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a).toString(),
};

async function temporaryStore(t, codec = encryption) {
  const directory = await mkdtemp(path.join(tmpdir(), "dock-mqtt-settings-test-"));
  t.after(() => rm(directory, { recursive: true }));
  return new SettingsStore(directory, codec);
}

test("settings validate endpoints, intervals and topics, rejecting URL credentials", () => {
  assert.equal(DEFAULT_SETTINGS.autoUpdate, false);
  assert.equal(normalizeSettings(valid).brokerUrl, valid.brokerUrl);
  assert.equal(normalizeSettings(DEFAULT_SETTINGS, true).brokerUrl, "");
  for (const patch of [
    { brokerUrl: "" }, { brokerUrl: "https://broker.example" },
    { brokerUrl: "mqtt://user:password@broker.example" }, { intervalMs: 0 },
    { intervalMs: "10000" }, { intervalMs: 1.5 }, { topic: "test/#" },
    { topic: "" }, { autoConnect: "yes" },
    { autoUpdate: "yes" },
  ]) {
    assert.throws(() => normalizeSettings({ ...valid, ...patch }));
  }
  assert.equal(settingsEnv(valid, "password").MQTT_PASSWORD, "password");
});

test("encrypted credentials persist but are not exposed to the renderer; empty keeps and clear removes", async t => {
  const store = await temporaryStore(t);
  assert.equal((await store.load()).hasPassword, false);
  const saved = await store.save(valid);
  assert.equal(saved.hasPassword, true);
  assert.equal("password" in saved, false);
  assert.equal((await readFile(store.file, "utf8")).includes(valid.password), false);
  const reloaded = new SettingsStore(path.dirname(store.file), encryption);
  await reloaded.load();
  assert.equal(reloaded.password, valid.password);
  await reloaded.save({ ...valid, password: "" });
  assert.equal(reloaded.password, valid.password);
  await reloaded.save({ ...valid, password: "", clearPassword: true });
  assert.equal(reloaded.password, "");
  assert.equal(reloaded.publicSettings().hasPassword, false);
});

test("unavailable OS encryption refuses credential persistence, rather than writing plaintext", async t => {
  const store = await temporaryStore(t, { isEncryptionAvailable: () => false });
  await assert.rejects(store.save(valid), /refusing.*plaintext/);
  await assert.rejects(readFile(store.file), { code: "ENOENT" });
  await store.save({ ...valid, password: "" });
});

test("corrupt settings are explicit errors, not silently reset", async t => {
  const store = await temporaryStore(t);
  await writeFile(store.file, "{broken");
  await assert.rejects(store.load(), SyntaxError);
  await writeFile(store.file, JSON.stringify({ version: 2 }));
  await assert.rejects(store.load(), /version/);
});

test("older saved settings enable discovery by default and new options persist", async t => {
  const store = await temporaryStore(t);
  const oldSettings = { ...DEFAULT_SETTINGS };
  delete oldSettings.discoveryEnabled;
  delete oldSettings.discoveryPrefix;
  delete oldSettings.autoUpdate;
  await writeFile(store.file, JSON.stringify({ version: 1, settings: oldSettings }));
  const loaded = await store.load();
  assert.equal(loaded.discoveryEnabled, true);
  assert.equal(loaded.discoveryPrefix, "homeassistant");
  assert.equal(loaded.autoUpdate, false);
  await store.save({ ...valid, discoveryEnabled: false, discoveryPrefix: "my_ha" });
  assert.equal(store.settings.autoUpdate, false);
  assert.equal(settingsEnv(store.settings).HA_DISCOVERY, "false");
  assert.equal(settingsEnv(store.settings).HA_DISCOVERY_PREFIX, "my_ha");
  assert.throws(() => normalizeSettings({ ...valid, discoveryPrefix: "ha/+" }), /prefix/);
});
