import hid from "node-hid";
import { PORTS, VENDOR_ID, PRODUCT_ID, USAGE_PAGE, INFO_COMMAND, infoRequest, parseReport, decodePort } from "./protocol.js";

export async function listDocks() {
  const devices = await hid.devicesAsync(VENDOR_ID, PRODUCT_ID);
  return devices.filter(device => device.usagePage === USAGE_PAGE);
}

// macOS: kIOReturnExclusiveAccess (0xE00002C5). Windows: CreateFile sharing violation.
const BUSY_PATTERN = /exclusive access|0xE00002C5|already open|sharing violation|being used by another process/i;

export class DockBusyError extends Error {
  constructor(cause) {
    super("The dock is in use by another app, most likely Anker Dock Manager. "
      + "Quit it (including from the menu bar or system tray); Dock MQTT retries automatically.", { cause });
    this.name = "DockBusyError";
    this.code = "DOCK_BUSY";
  }
}

export function isDockBusyError(error) {
  return error?.code === "DOCK_BUSY" || BUSY_PATTERN.test(error?.message ?? "");
}

export class DockNotFoundError extends Error {
  constructor(message = "A83B3 HID interface not found. Check the USB connection and DOCK_SERIAL.") {
    super(message);
    this.name = "DockNotFoundError";
    this.code = "DOCK_NOT_FOUND";
  }
}

// Errors node-hid raises when an already-open dock is unplugged mid-read.
const MISSING_PATTERN = /could not read from HID device|device (has been )?disconnected|device not configured/i;

export function isDockMissingError(error) {
  return error?.code === "DOCK_NOT_FOUND" || MISSING_PATTERN.test(error?.message ?? "");
}

export class Dock {
  constructor(device, info) {
    this.device = device;
    this.info = info;
    this.pending = null;
    this.failure = null;
    this.closed = false;
    device.on("data", report => this.receive(report));
    device.on("error", error => {
      this.failure = error;
      this.pending?.reject(error);
    });
  }

  static async open(serial) {
    const devices = (await listDocks()).filter(device => !serial || device.serialNumber === serial);
    if (devices.length === 0) throw new DockNotFoundError();
    if (devices.length > 1) throw new Error("Multiple A83B3 docks found. Set DOCK_SERIAL to select one.");
    const info = devices[0];
    let device;
    try {
      device = await hid.HIDAsync.open(info.path);
    } catch (error) {
      throw isDockBusyError(error) ? new DockBusyError(error) : error;
    }
    return new Dock(device, info);
  }

  receive(report) {
    const pending = this.pending;
    if (!pending || report[2] !== INFO_COMMAND || report[1] !== pending.port) return;
    try {
      const packet = parseReport(report);
      if (pending.remaining !== null && packet.remaining !== pending.remaining - 1) {
        throw new Error("Out-of-order HID response");
      }
      pending.remaining = packet.remaining;
      pending.chunks.push(packet.payload);
      if (packet.remaining === 0) pending.resolve(Buffer.concat(pending.chunks));
    } catch (error) {
      pending.reject(error);
    }
  }

  async query(port, timeoutMs = 3000, { signal, shouldQuery = () => true } = {}) {
    const checkAllowed = () => {
      if (signal?.aborted || !shouldQuery()) throw new Error("Dock polling paused: MQTT is disconnected or bridge stopped");
    };
    checkAllowed();
    if (this.closed) throw new Error("Dock is closed");
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("Concurrent HID requests are not supported");
    const report = infoRequest(port);
    let timer;
    let onAbort;
    const response = new Promise((resolve, reject) => {
      this.pending = { port, remaining: null, chunks: [], resolve, reject };
      timer = setTimeout(() => reject(new Error(`Timed out reading port 0x${port.toString(16)}`)), timeoutMs);
      onAbort = () => reject(new Error("Dock polling cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const write = Promise.resolve().then(() => {
      checkAllowed();
      return this.device.write([...report]);
    }).then(count => {
      if (count !== report.length) throw new Error(`Incomplete HID write: ${count}/64 bytes`);
    });
    try {
      const [payload] = await Promise.all([response, write]);
      return payload;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.pending = null;
    }
  }

  async snapshot(options) {
    const ports = {};
    for (const [name, port] of Object.entries(PORTS)) {
      ports[name] = decodePort(name, await this.query(port, 3000, options));
    }
    return {
      timestamp: new Date().toISOString(),
      device: {
        model: "A83B3",
        product: this.info.product,
        manufacturer: this.info.manufacturer,
        serial: this.info.serialNumber,
        usb_vendor_id: VENDOR_ID,
        usb_product_id: PRODUCT_ID,
        usb_release: this.info.release,
      },
      ports,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pending?.reject(new Error("Dock connection closed"));
    await this.device.close();
  }
}
