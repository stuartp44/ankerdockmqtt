import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkForStableUpdate,
  downloadAndVerifyUpdate,
  selectPlatformAsset,
  verifyReleaseManifest,
} from "../desktop/updates.js";

function signedManifest(tag, assets, keyPair) {
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, tag, assets })}\n`);
  return { bytes, signature: sign(null, bytes, keyPair.privateKey) };
}

function releaseAsset(tag, name, size = 1) {
  return {
    name,
    size,
    browser_download_url: `https://github.com/stuartp44/ankerdockmqtt/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}

test("release manifest signature and expected tag are verified", () => {
  const keys = generateKeyPairSync("ed25519");
  const { bytes, signature } = signedManifest("v1.2.0", [{
    name: "Dock MQTT Setup 1.2.0.exe",
    sha256: "a".repeat(64),
    size: 20,
  }], keys);
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyReleaseManifest(bytes, signature, publicKey, "v1.2.0").assets.length, 1);
  assert.throws(() => verifyReleaseManifest(bytes, signature, publicKey, "v1.2.1"), /mismatched/);
  assert.throws(() => verifyReleaseManifest(bytes, Buffer.alloc(signature.length), publicKey, "v1.2.0"), /signature/);
});

test("platform package selection is explicit and rejects unsupported targets", () => {
  const assets = [
    { name: "Dock MQTT Setup 1.2.0.exe" },
    { name: "Dock MQTT-1.2.0-mac.zip" },
    { name: "Dock MQTT-1.2.0-arm64-mac.zip" },
  ];
  assert.equal(selectPlatformAsset(assets, "1.2.0", "win32", "x64").name, "Dock MQTT Setup 1.2.0.exe");
  assert.equal(selectPlatformAsset(assets, "1.2.0", "darwin", "arm64").name, "Dock MQTT-1.2.0-arm64-mac.zip");
  assert.throws(() => selectPlatformAsset(assets, "1.2.0", "linux", "x64"), /not supported/);
});

test("stable update lookup authenticates the manifest and chooses the current platform", async () => {
  const keys = generateKeyPairSync("ed25519");
  const packageName = "Dock MQTT Setup 1.2.0.exe";
  const payload = Buffer.from("installer bytes");
  const manifest = signedManifest("v1.2.0", [{
    name: packageName,
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.length,
  }], keys);
  const api = {
    tag_name: "v1.2.0",
    draft: false,
    prerelease: false,
    assets: [
      releaseAsset("v1.2.0", "update-manifest.json", manifest.bytes.length),
      releaseAsset("v1.2.0", "update-manifest.json.sig", manifest.signature.length),
      releaseAsset("v1.2.0", packageName, payload.length),
    ],
  };
  const fetchImpl = async url => {
    if (url === "https://api.github.com/repos/stuartp44/ankerdockmqtt/releases/latest") {
      return Response.json(api);
    }
    if (url.endsWith("/update-manifest.json")) return new Response(manifest.bytes);
    if (url.endsWith("/update-manifest.json.sig")) return new Response(manifest.signature);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const result = await checkForStableUpdate({
    currentVersion: "1.1.9",
    platform: "win32",
    arch: "x64",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    fetchImpl,
  });
  assert.equal(result.available, true);
  assert.equal(result.version, "1.2.0");
  assert.equal(result.asset.name, packageName);
  assert.equal((await checkForStableUpdate({
    currentVersion: "1.2.0",
    platform: "win32",
    arch: "x64",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    fetchImpl,
  })).available, false);
});

test("download is saved only after its signed SHA-256 and size match", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "dock-mqtt-update-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from("verified installer");
  const asset = {
    name: "Dock MQTT Setup 1.2.0.exe",
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.length,
    url: "https://github.com/stuartp44/ankerdockmqtt/releases/download/v1.2.0/Dock%20MQTT%20Setup.exe",
  };
  const fetchImpl = async () => new Response(payload);
  const savedPath = await downloadAndVerifyUpdate(asset, directory, { fetchImpl });
  assert.deepEqual(await readFile(savedPath), payload);

  await rm(savedPath);
  await assert.rejects(
    downloadAndVerifyUpdate({ ...asset, sha256: "0".repeat(64) }, directory, { fetchImpl }),
    /SHA-256/,
  );
  assert.deepEqual(await readdir(directory), []);
});
