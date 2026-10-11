const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;

// macOS Local Network privacy identifies programs by Mach-O LC_UUID (Apple TN3179).
// Electron's prebuilt binaries keep the same UUID in every app, so macOS would
// confuse Dock MQTT with Electron.app. Derive a stable, app-specific UUID instead.
function uniqueUuid(slice, appId) {
  if (slice.readUInt32LE(0) !== MH_MAGIC_64) return 0;
  const commands = slice.readUInt32LE(16);
  let offset = 32;
  for (let i = 0; i < commands; i++) {
    const cmd = slice.readUInt32LE(offset);
    const size = slice.readUInt32LE(offset + 4);
    if (cmd === LC_UUID) {
      const uuid = slice.subarray(offset + 8, offset + 24);
      const replacement = createHash("sha256").update(appId).update(uuid).digest().subarray(0, 16);
      replacement[6] = (replacement[6] & 0x0f) | 0x50;
      replacement[8] = (replacement[8] & 0x3f) | 0x80;
      replacement.copy(uuid);
      return 1;
    }
    offset += size;
  }
  return 0;
}

function patchExecutable(file, appId) {
  const data = readFileSync(file);
  let patched = 0;
  if (data.readUInt32BE(0) === FAT_MAGIC) {
    const count = data.readUInt32BE(4);
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * 20;
      const start = data.readUInt32BE(entry + 8);
      patched += uniqueUuid(data.subarray(start, start + data.readUInt32BE(entry + 12)), appId);
    }
  } else {
    patched = uniqueUuid(data, appId);
  }
  if (!patched) throw new Error(`No Mach-O UUID found in ${file}`);
  writeFileSync(file, data);
}

function bundleExecutables(app) {
  const executables = [];
  const collect = bundle => {
    const macos = path.join(bundle, "Contents", "MacOS");
    for (const name of readdirSync(macos)) executables.push(path.join(macos, name));
  };
  collect(app);
  const frameworks = path.join(app, "Contents", "Frameworks");
  for (const name of readdirSync(frameworks)) {
    if (name.endsWith(".app")) collect(path.join(frameworks, name));
  }
  return executables;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" || process.platform !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const appId = context.packager.appInfo.id;
  for (const executable of bundleExecutables(app)) patchExecutable(executable, appId);
  // Without a Developer ID, electron-builder leaves Electron's linker signature, which
  // is now invalid after patching. Re-sign ad hoc so macOS attributes permissions to
  // this bundle identifier. Developer ID builds are signed later by electron-builder.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
