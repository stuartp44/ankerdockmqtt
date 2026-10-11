import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { validateConnection } from "../src/service.js";

export const DEFAULT_SETTINGS = Object.freeze({
  brokerUrl: "",
  username: "",
  topic: "anker/dock",
  clientId: "",
  serial: "",
  intervalMs: 10000,
  autoConnect: false,
  autoUpdate: false,
  discoveryEnabled: true,
  discoveryPrefix: "homeassistant",
});

export function normalizeSettings(input, allowEmptyBroker = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid settings object");
  }
  const settings = {};
  for (const key of ["brokerUrl", "username", "topic", "clientId", "serial"]) {
    if (typeof input[key] !== "string" || input[key].length > 2048) {
      throw new Error(`Invalid ${key}`);
    }
    settings[key] = input[key].trim();
  }
  if (typeof input.autoConnect !== "boolean") throw new Error("Invalid autoConnect");
  settings.autoUpdate = input.autoUpdate ?? false;
  if (typeof settings.autoUpdate !== "boolean") throw new Error("Invalid autoUpdate");
  if (typeof input.intervalMs !== "number") throw new Error("Invalid polling interval");
  settings.intervalMs = input.intervalMs;
  settings.autoConnect = input.autoConnect;
  settings.discoveryEnabled = input.discoveryEnabled ?? true;
  settings.discoveryPrefix = input.discoveryPrefix ?? "homeassistant";
  if (typeof settings.discoveryEnabled !== "boolean" || typeof settings.discoveryPrefix !== "string") {
    throw new Error("Invalid Home Assistant discovery settings");
  }
  settings.discoveryPrefix = settings.discoveryPrefix.trim();
  validateConnection(settingsEnv({
    ...settings,
    brokerUrl: allowEmptyBroker && !settings.brokerUrl ? "mqtt://localhost:1883" : settings.brokerUrl,
  }));
  if (settings.brokerUrl) {
    const url = new URL(settings.brokerUrl);
    if (url.username || url.password) {
      throw new Error("Use the username and password fields, not credentials in the broker URL");
    }
  }
  return settings;
}

export function settingsEnv(settings, password = "") {
  return {
    MQTT_URL: settings.brokerUrl,
    MQTT_USERNAME: settings.username || undefined,
    MQTT_PASSWORD: password || undefined,
    MQTT_TOPIC: settings.topic,
    MQTT_CLIENT_ID: settings.clientId || undefined,
    DOCK_SERIAL: settings.serial || undefined,
    POLL_INTERVAL_MS: settings.intervalMs,
    HA_DISCOVERY: String(settings.discoveryEnabled ?? true),
    HA_DISCOVERY_PREFIX: settings.discoveryPrefix ?? "homeassistant",
  };
}

export class SettingsStore {
  constructor(directory, encryption) {
    this.file = path.join(directory, "settings.json");
    this.encryption = encryption;
    this.settings = { ...DEFAULT_SETTINGS };
    this.password = "";
  }

  publicSettings() {
    return { ...this.settings, hasPassword: Boolean(this.password) };
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return this.publicSettings();
      throw error;
    }
    const saved = JSON.parse(text);
    if (saved.version !== 1) throw new Error("Unsupported settings file version");
    const settings = normalizeSettings(saved.settings, true);
    let password = "";
    if (saved.encryptedPassword) {
      if (!this.encryption.isEncryptionAvailable()) {
        throw new Error("OS credential encryption is unavailable; saved password cannot be read");
      }
      password = this.encryption.decryptString(Buffer.from(saved.encryptedPassword, "base64"));
    }
    this.settings = settings;
    this.password = password;
    return this.publicSettings();
  }

  async save(input) {
    const settings = normalizeSettings(input);
    if (typeof input.password !== "string" || input.password.length > 4096
      || typeof input.clearPassword !== "boolean") {
      throw new Error("Invalid password settings");
    }
    const password = input.clearPassword ? "" : input.password || this.password;
    let encryptedPassword = "";
    if (password) {
      if (!this.encryption.isEncryptionAvailable()) {
        throw new Error("OS credential encryption is unavailable; refusing to save a plaintext password");
      }
      encryptedPassword = this.encryption.encryptString(password).toString("base64");
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, settings, encryptedPassword }, null, 2), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
    this.settings = settings;
    this.password = password;
    return this.publicSettings();
  }
}
