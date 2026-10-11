import { createHash, randomUUID, verify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const RELEASE_API = "https://api.github.com/repos/stuartp44/ankerdockmqtt/releases/latest";
const RELEASE_DOWNLOAD_PREFIX = "https://github.com/stuartp44/ankerdockmqtt/releases/download/";
const MAX_PACKAGE_SIZE = 1024 * 1024 * 1024;
const REQUEST_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Dock-MQTT",
};

function releaseVersion(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? "");
  if (!match) return null;
  const version = match.slice(1).map(Number);
  return version.every(Number.isSafeInteger) ? version : null;
}

function compareVersions(left, right) {
  const a = releaseVersion(`v${left}`);
  const b = releaseVersion(`v${right}`);
  if (!a || !b) throw new Error("Unsupported application version");
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function releaseAsset(release, name) {
  const githubName = name.replaceAll(" ", ".");
  const asset = release.assets?.find(candidate => candidate.name === name || candidate.name === githubName);
  if (!asset || typeof asset.browser_download_url !== "string") {
    throw new Error(`Release is missing ${name}`);
  }
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com"
    || !url.pathname.startsWith(`/stuartp44/ankerdockmqtt/releases/download/${release.tag_name}/`)) {
    throw new Error(`Unexpected GitHub release asset URL for ${name}`);
  }
  return asset;
}

async function fetchBytes(url, fetchImpl, maxBytes) {
  const response = await fetchImpl(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GitHub download failed (${response.status})`);
  return readLimitedResponse(response, maxBytes);
}

async function readLimitedResponse(response, maxBytes) {
  if (!response.body) throw new Error("GitHub response has no body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("GitHub release metadata is unexpectedly large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export function verifyReleaseManifest(manifestBytes, signature, publicKey, expectedTag) {
  if (!verify(null, manifestBytes, publicKey, signature)) {
    throw new Error("Release manifest signature verification failed");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Signed release manifest is invalid JSON: ${error.message}`);
  }
  if (manifest.schemaVersion !== 1 || manifest.tag !== expectedTag || !Array.isArray(manifest.assets)) {
    throw new Error("Signed release manifest has an unsupported or mismatched format");
  }
  const seen = new Set();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.name !== "string" || path.basename(asset.name) !== asset.name
      || seen.has(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE_SIZE) {
      throw new Error("Signed release manifest contains an invalid package entry");
    }
    seen.add(asset.name);
  }
  return manifest;
}

export function selectPlatformAsset(assets, version, platform, arch) {
  let legacyName;
  if (platform === "win32" && arch === "x64") legacyName = `Dock MQTT Setup ${version}.exe`;
  else if (platform === "darwin" && arch === "x64") legacyName = `Dock MQTT-${version}-mac.zip`;
  else if (platform === "darwin" && arch === "arm64") legacyName = `Dock MQTT-${version}-arm64-mac.zip`;
  else throw new Error(`Automatic updates are not supported on ${platform}/${arch}`);
  const githubName = legacyName.replaceAll(" ", ".");
  const asset = assets.find(candidate => candidate.name === githubName)
    ?? assets.find(candidate => candidate.name === legacyName);
  if (!asset) throw new Error(`Stable release is missing the package for ${platform}/${arch}`);
  return asset;
}

export async function checkForStableUpdate({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  publicKey,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(RELEASE_API, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not check GitHub releases (${response.status})`);
  let release;
  try {
    release = JSON.parse((await readLimitedResponse(response, 1024 * 1024)).toString("utf8"));
  } catch (error) {
    throw new Error(`GitHub release metadata is invalid: ${error.message}`);
  }
  const parsedVersion = releaseVersion(release.tag_name);
  if (release.draft || release.prerelease || !parsedVersion) {
    throw new Error("GitHub returned an invalid stable release");
  }
  const manifestAsset = releaseAsset(release, "update-manifest.json");
  const signatureAsset = releaseAsset(release, "update-manifest.json.sig");
  const [manifestBytes, signature] = await Promise.all([
    fetchBytes(manifestAsset.browser_download_url, fetchImpl, 64 * 1024),
    fetchBytes(signatureAsset.browser_download_url, fetchImpl, 1024),
  ]);
  const manifest = verifyReleaseManifest(manifestBytes, signature, publicKey, release.tag_name);
  const version = release.tag_name.slice(1);
  if (compareVersions(version, currentVersion) <= 0) {
    return { available: false, currentVersion, latestVersion: version };
  }

  const selected = selectPlatformAsset(manifest.assets, version, platform, arch);
  const githubAsset = releaseAsset(release, selected.name);
  if (githubAsset.size !== selected.size) throw new Error("GitHub package size does not match the signed manifest");
  return {
    available: true,
    currentVersion,
    version,
    tag: release.tag_name,
    asset: { ...selected, url: githubAsset.browser_download_url },
  };
}

export async function downloadAndVerifyUpdate(asset, destination, { fetchImpl = fetch } = {}) {
  if (!asset || typeof asset.name !== "string" || path.basename(asset.name) !== asset.name
    || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size)
    || asset.size <= 0 || asset.size > MAX_PACKAGE_SIZE
    || typeof asset.url !== "string" || !asset.url.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
    throw new Error("Refusing to download an invalid release package");
  }
  await mkdir(destination, { recursive: true });
  const finalPath = path.join(destination, asset.name);
  const partialPath = `${finalPath}.${randomUUID()}.partial`;
  const response = await fetchImpl(asset.url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Release package download failed (${response.status})`);

  const hash = createHash("sha256");
  let bytesWritten = 0;
  const verifyStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > asset.size) return callback(new Error("Downloaded package exceeds its signed size"));
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytesWritten !== asset.size) return callback(new Error("Downloaded package size does not match the signed manifest"));
      callback();
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), verifyStream, createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex") !== asset.sha256) throw new Error("Downloaded package SHA-256 does not match the signed manifest");
    await rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}
