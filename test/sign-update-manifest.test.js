import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseManifest } from "../desktop/updates.js";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("release signing produces a manifest matching the pinned public key", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "dock-mqtt-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "dist");
  const desktop = path.join(directory, "desktop");
  await mkdir(output);
  await mkdir(desktop);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  await writeFile(path.join(desktop, "update-signing-public.pem"), publicKey);
  await writeFile(path.join(output, "Dock MQTT Setup 1.2.0.exe"), "windows");
  await writeFile(path.join(output, "Dock MQTT-1.2.0-mac.zip"), "mac-x64");
  await writeFile(path.join(output, "Dock MQTT-1.2.0-arm64-mac.zip"), "mac-arm64");

  const script = path.join(root, "scripts", "sign-update-manifest.js");
  const env = { ...process.env, UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
  await execFileAsync(process.execPath, [script, "v1.2.0", output], { cwd: directory, env });
  const manifest = await readFile(path.join(output, "update-manifest.json"));
  const signature = await readFile(path.join(output, "update-manifest.json.sig"));
  const verified = verifyReleaseManifest(manifest, signature, publicKey, "v1.2.0");
  assert.equal(verified.assets.length, 3);
  assert.deepEqual(verified.assets.map(asset => asset.name).sort(), [
    "Dock.MQTT-1.2.0-arm64-mac.zip",
    "Dock.MQTT-1.2.0-mac.zip",
    "Dock.MQTT.Setup.1.2.0.exe",
  ]);

  const otherKeys = generateKeyPairSync("ed25519");
  await assert.rejects(execFileAsync(process.execPath, [script, "v1.2.0", output], {
    cwd: directory,
    env: { ...env, UPDATE_SIGNING_PRIVATE_KEY: otherKeys.privateKey.export({ type: "pkcs8", format: "pem" }) },
  }), /does not match/);
});
