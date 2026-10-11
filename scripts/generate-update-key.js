import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const privateKeyPath = path.join(root, "update-signing-private.pem");
const publicKeyPath = path.join(root, "desktop", "update-signing-public.pem");

for (const file of [privateKeyPath, publicKeyPath]) {
  try {
    await access(file);
    throw new Error(`Refusing to overwrite existing key file: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
await mkdir(path.dirname(publicKeyPath), { recursive: true });
await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx" });

console.log("Created the update signing key pair.");
console.log("Commit desktop/update-signing-public.pem so packaged apps can verify releases.");
console.log("Add the private key to GitHub Actions secrets as UPDATE_SIGNING_PRIVATE_KEY:");
console.log("  gh secret set UPDATE_SIGNING_PRIVATE_KEY < update-signing-private.pem");
console.log("Keep the private key secure and never commit or distribute it.");
