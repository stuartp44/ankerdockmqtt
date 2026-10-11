import { test } from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_ARG, loginItemState, openedAtLogin, setLoginItem } from "../desktop/login.js";

function fakeApp(initial = {}) {
  const app = {
    item: { openAtLogin: false, ...initial },
    calls: [],
    getLoginItemSettings(options) {
      app.calls.push(["get", options]);
      return app.item;
    },
    setLoginItemSettings(settings) {
      app.calls.push(["set", settings]);
      app.item = { ...app.item, openAtLogin: settings.openAtLogin };
    },
  };
  return app;
}

test("macOS registers the app itself as a login item", () => {
  const app = fakeApp();
  assert.deepEqual(setLoginItem(app, true, "darwin"), { supported: true, enabled: true, requiresApproval: false });
  assert.deepEqual(app.calls[0], ["set", { openAtLogin: true }]);
  assert.deepEqual(setLoginItem(app, false, "darwin").enabled, false);
});

test("Windows login item launches hidden and queries with the same arguments", () => {
  const app = fakeApp();
  setLoginItem(app, true, "win32");
  assert.deepEqual(app.calls[0], ["set", { openAtLogin: true, args: [HIDDEN_ARG] }]);
  assert.deepEqual(app.calls[1], ["get", { args: [HIDDEN_ARG] }]);
});

test("reports pending macOS approval instead of failing", () => {
  const app = fakeApp({ status: "requires-approval" });
  app.setLoginItemSettings = () => {};
  assert.deepEqual(setLoginItem(app, true, "darwin"), { supported: true, enabled: false, requiresApproval: true });
});

test("rejects invalid values, unsupported platforms and silent OS refusals", () => {
  const app = fakeApp();
  assert.throws(() => setLoginItem(app, "yes", "darwin"), /Invalid/);
  assert.throws(() => setLoginItem(app, true, "linux"), /only supported/);
  app.setLoginItemSettings = () => {};
  assert.throws(() => setLoginItem(app, true, "win32"), /did not enable/);
});

test("detects login launches so the window stays hidden", () => {
  assert.equal(openedAtLogin(fakeApp(), ["Dock MQTT.exe", HIDDEN_ARG], "win32"), true);
  assert.equal(openedAtLogin(fakeApp(), ["Dock MQTT.exe"], "win32"), false);
  assert.equal(openedAtLogin(fakeApp({ wasOpenedAtLogin: true }), ["Dock MQTT"], "darwin"), true);
  assert.equal(openedAtLogin(fakeApp({ wasOpenedAtLogin: false }), ["Dock MQTT"], "darwin"), false);
});
