import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const [releaseTag, outputDirectory = "dist"] = process.argv.slice(2);
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseTag ?? "")) {
  throw new Error("Expected a stable version tag such as v0.3.0");
}
if (!process.env.UPDATE_SIGNING_PRIVATE_KEY) {
  throw new Error("Missing UPDATE_SIGNING_PRIVATE_KEY GitHub Actions secret");
}

const version = releaseTag.slice(1);
const filenames = (await readdir(outputDirectory)).filter(name => name.endsWith(".exe") || name.endsWith(".zip")).sort();
const expected = [
  `Dock MQTT Setup ${version}.exe`,
  `Dock MQTT-${version}-mac.zip`,
  `Dock MQTT-${version}-arm64-mac.zip`,
].sort();
if (JSON.stringify(filenames) !== JSON.stringify(expected)) {
  throw new Error(`Release packages did not match expected files. Expected ${expected.join(", ")}; found ${filenames.join(", ")}`);
}

const assets = [];
for (const name of filenames) {
  const file = path.join(outputDirectory, name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assets.push({ name: name.replaceAll(" ", "."), size: (await stat(file)).size, sha256: hash.digest("hex") });
}

const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, tag: releaseTag, assets }, null, 2)}\n`);
const privateKey = createPrivateKey(process.env.UPDATE_SIGNING_PRIVATE_KEY);
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Update signing key must be Ed25519");
const signature = sign(null, manifest, privateKey);
const publicKey = createPublicKey(await readFile("desktop/update-signing-public.pem"));
if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, manifest, publicKey, signature)) {
  throw new Error("UPDATE_SIGNING_PRIVATE_KEY does not match desktop/update-signing-public.pem");
}
await writeFile(path.join(outputDirectory, "update-manifest.json"), manifest);
await writeFile(path.join(outputDirectory, "update-manifest.json.sig"), signature);
console.log(`Signed SHA-256 manifest for ${releaseTag} (${assets.length} packages).`);
