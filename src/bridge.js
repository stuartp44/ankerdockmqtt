import { Dock, listDocks } from "./dock.js";
import { runBridge } from "./service.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--once", "--list"].includes(arg)) || args.length > 1) {
    throw new Error("Usage: node src/bridge.js [--list | --once]");
  }
  if (args[0] === "--list") {
    console.log(JSON.stringify(await listDocks(), null, 2));
    return;
  }
  if (args[0] === "--once") {
    const dock = await Dock.open(process.env.DOCK_SERIAL);
    try {
      console.log(JSON.stringify(await dock.snapshot(), null, 2));
    } finally {
      await dock.close();
    }
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runBridge({
      env: process.env,
      signal: abort.signal,
      onState: state => console.error(`Bridge: ${state.status}`),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
