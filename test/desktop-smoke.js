import { _electron as electron } from "playwright-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
import createAedes from "aedes";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = await mkdtemp(path.join(tmpdir(), "dock-mqtt-desktop-smoke-"));
const broker = createAedes();
const server = createServer(broker.handle);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `mqtt://127.0.0.1:${server.address().port}`;
const discovery = new Map();
broker.on("publish", packet => {
  if (packet.topic.startsWith("homeassistant/") && packet.topic.endsWith("/config")) {
    discovery.set(packet.topic, JSON.parse(packet.payload.toString()));
  }
});
let application;
try {
  application = await electron.launch({
    ...(process.env.APP_EXECUTABLE ? { executablePath: process.env.APP_EXECUTABLE } : {}),
    args: [
      ...(process.env.APP_EXECUTABLE ? [] : [root]),
      `--user-data-dir=${profile}`,
      // Rebuilt ad-hoc-signed apps trigger a Keychain password prompt; the mock keychain keeps tests unattended.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ],
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector("#start")?.disabled === false);
  assert.equal(await page.title(), "Dock MQTT");
  const syntheticSnapshot = {
    timestamp: "2026-01-01T12:00:00Z",
    ports: {
      host: { power_w: 25.9 },
      upstream: { link: "SS+" },
      ethernet: { max_bandwidth_mbps: 1000 },
    },
  };
  for (const status of ["paused", "disconnected", "busy", "error", "stopping", "stopped", "reading"]) {
    await page.evaluate(snapshot => render({ status: "online", snapshot }), syntheticSnapshot);
    assert.equal(await page.locator("#summary .metric").count(), 3);
    assert.match(await page.locator("#summary").textContent(), /25.9 W/);
    await page.evaluate(({ status, snapshot }) => render({ status, snapshot }), { status, snapshot: syntheticSnapshot });
    assert.equal(await page.locator("#summary .metric").count(), 0);
    assert.equal(await page.locator("#timestamp").textContent(), "No live telemetry");
    assert.match(await page.locator("#telemetry").textContent(), /^No live telemetry/);
  }
  await page.evaluate(snapshot => render({ status: "online", snapshot }), syntheticSnapshot);
  await page.evaluate(() => render({ status: "stopped", snapshot: null }));
  assert.equal(await page.locator("#summary .metric").count(), 0);
  console.log("Telemetry clears outside online state and fresh readings restore the cards");
  await page.click("#start");
  await page.waitForFunction(() => !document.querySelector("#error").hidden);
  assert.match(await page.locator("#error").innerText(), /MQTT_URL/);
  await page.fill('[name="brokerUrl"]', url);
  await page.fill('[name="topic"]', "smoke/dock");
  await page.fill('[name="interval"]', "1");
  assert.equal(await page.locator('[name="discoveryEnabled"]').isChecked(), true);
  const loginItem = await page.evaluate(() => window.dockApp.loginItem());
  assert.equal(loginItem.ok, true);
  assert.equal(await page.locator("#startAtLogin").isChecked(), loginItem.value.enabled);
  await page.fill('[name="password"]', "smoke-test-not-a-real-secret");
  await page.click("#save");
  await page.waitForFunction(() => document.querySelector('[name="password"]').value === ""
    && document.querySelector('[name="password"]').placeholder.startsWith("Saved"));
  const saved = await readFile(path.join(profile, "settings.json"), "utf8");
  assert.equal(saved.includes("smoke-test-not-a-real-secret"), false);
  assert.ok(JSON.parse(saved).encryptedPassword);
  console.log("Desktop window, IPC validation, and OS-encrypted password persistence passed");
  await page.check('[name="clearPassword"]');
  await page.click("#save");
  await page.waitForFunction(() => document.querySelector('[name="password"]').placeholder === "Optional");
  await page.click("#refresh");
  await page.waitForFunction(() => document.querySelector("#devices").textContent.length > 0);
  if (process.env.LIVE_DOCK === "1") {
    await page.click("#start");
    await page.waitForFunction(() => document.querySelector("#status").textContent === "online", null, { timeout: 20000 });
    const snapshot = JSON.parse(await page.locator("#telemetry").textContent());
    assert.equal(snapshot.device.model, "A83B3");
    assert.equal(Object.keys(snapshot.ports).length, 10);
    assert.equal(typeof snapshot.ports.host.power_w, "number");
    assert.equal(discovery.size, 34);
    assert.ok([...discovery.values()].every(config => config.availability_topic === "smoke/dock/availability"));
    assert.equal(await page.locator('[name="brokerUrl"]').isDisabled(), true);
    console.log(`Live desktop -> USB dock -> MQTT passed: ${snapshot.ports.host.power_w} W, 10 ports`);
    const activeClients = Object.values(broker.clients);
    assert.equal(activeClients.length, 1);
    await new Promise(resolve => activeClients[0].close(resolve));
    await page.waitForFunction(() => document.querySelector("#status").textContent === "paused", null, { timeout: 10000 });
    console.log("MQTT disconnect changed the desktop status to paused");
    await page.waitForFunction(() => document.querySelector("#status").textContent === "online", null, { timeout: 20000 });
    assert.equal(discovery.size, 34);
    console.log("Reconnect resumed live telemetry with the same 34 Home Assistant discovery entities");
    await page.click("#stop");
    await page.waitForFunction(() => document.querySelector("#start").disabled === false);
    assert.equal(await page.locator("#status").textContent(), "stopped");
    console.log("Stop released USB connection and returned the UI to stopped");
  }
  if (process.env.SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const hidden = await application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible());
  assert.equal(hidden, true);
  assert.deepEqual(errors, []);
  console.log("Close-to-tray behavior and renderer error check passed");
} finally {
  if (application) await application.close();
  await new Promise(resolve => broker.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true });
}
