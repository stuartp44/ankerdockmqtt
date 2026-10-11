import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = [
  { folder: "win-unpacked/resources", platform: "win32", arch: "x64" },
  { folder: "mac/Dock MQTT.app/Contents/Resources", platform: "darwin", arch: "x64" },
  { folder: "mac-arm64/Dock MQTT.app/Contents/Resources", platform: "darwin", arch: "arm64" },
];

function lookup(header, name) {
  return name.split("/").reduce((entry, component) => entry?.files?.[component], header);
}

for (const target of targets) {
  const resources = path.join(root, "dist", target.folder);
  const archive = await readFile(path.join(resources, "app.asar"));
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString());
  for (const file of ["desktop/main.js", "desktop/preload.cjs", "desktop/index.html", "src/service.js"]) {
    assert.ok(lookup(header, file), `Missing ${file} in ${target.platform}/${target.arch}`);
  }
  assert.equal(lookup(header, "node_modules/node-hid/build"), undefined,
    "Locally compiled HID fallback must not override platform-specific prebuilds");
  const binaryPath = `node_modules/node-hid/prebuilds/HID-${target.platform}-${target.arch}/node-napi-v4.node`;
  assert.equal(lookup(header, binaryPath)?.unpacked, true, "Native HID binary must be outside ASAR");
  const binary = await readFile(path.join(resources, "app.asar.unpacked", binaryPath));
  if (target.platform === "win32") {
    assert.equal(binary.toString("ascii", 0, 2), "MZ");
    const pe = binary.readUInt32LE(0x3c);
    assert.equal(binary.readUInt32LE(pe), 0x4550);
    assert.equal(binary.readUInt16LE(pe + 4), 0x8664, "Expected an x64 Windows PE binary");
  } else {
    assert.equal(binary.readUInt32LE(0), 0xfeedfacf, "Expected a 64-bit Mach-O binary");
    assert.equal(binary.readUInt32LE(4), target.arch === "arm64" ? 0x100000c : 0x1000007);
  }
  console.log(`${target.platform}/${target.arch}: app entry points and native HID architecture passed`);
}
