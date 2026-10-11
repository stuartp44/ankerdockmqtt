export const HIDDEN_ARG = "--hidden";

export function loginItemState(app, platform = process.platform) {
  const query = platform === "win32" ? { args: [HIDDEN_ARG] } : undefined;
  const item = app.getLoginItemSettings(query);
  return {
    supported: platform === "darwin" || platform === "win32",
    enabled: Boolean(item.openAtLogin),
    requiresApproval: item.status === "requires-approval",
  };
}

export function setLoginItem(app, enabled, platform = process.platform) {
  if (typeof enabled !== "boolean") throw new Error("Invalid start at login setting");
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Start at login is only supported on macOS and Windows");
  }
  app.setLoginItemSettings(platform === "win32"
    ? { openAtLogin: enabled, args: [HIDDEN_ARG] }
    : { openAtLogin: enabled });
  const state = loginItemState(app, platform);
  if (state.enabled !== enabled && !state.requiresApproval) {
    throw new Error(`The operating system did not ${enabled ? "enable" : "disable"} start at login`);
  }
  return state;
}

export function openedAtLogin(app, argv = process.argv, platform = process.platform) {
  if (argv.includes(HIDDEN_ARG)) return true;
  return platform === "darwin" && Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
}
