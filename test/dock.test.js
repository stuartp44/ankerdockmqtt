import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Dock, DockBusyError, DockNotFoundError, isDockBusyError, isDockMissingError } from "../src/dock.js";
import { PORTS } from "../src/protocol.js";

function response(port, payload, remaining = 0) {
  const report = Buffer.alloc(64);
  report.set([0x95, port, 0x66, remaining, payload.length + 6]);
  report.set(payload, 5);
  report[payload.length + 5] = report.subarray(0, payload.length + 5)
    .reduce((sum, byte) => sum ^ byte, 0);
  return report;
}

class FakeHid extends EventEmitter {
  constructor(reply = () => {}) {
    super();
    this.reply = reply;
    this.closed = false;
  }

  async write(report) {
    queueMicrotask(() => this.reply(report, this));
    return report.length;
  }

  async close() {
    this.closed = true;
  }
}

test("queries match the requested port and assemble all fragments including the last", async () => {
  const device = new FakeHid((report, self) => {
    self.emit("data", response(PORTS.usb_c2, Buffer.from([99])));
    self.emit("data", response(report[1], Buffer.from([1, 2]), 1));
    self.emit("data", response(report[1], Buffer.from([3, 4]), 0));
  });
  const dock = new Dock(device, {});
  assert.deepEqual(await dock.query(PORTS.host), Buffer.from([1, 2, 3, 4]));
  await dock.close();
  assert.equal(device.closed, true);
});

test("timeouts poison the connection to prevent stale responses matching later queries", async () => {
  const dock = new Dock(new FakeHid(), {});
  await assert.rejects(dock.query(PORTS.host, 10), /Timed out/);
  await assert.rejects(dock.query(PORTS.host), /Timed out/);
  assert.equal(dock.pending, null);
  await dock.close();
});

test("bad checksums, skipped fragments, incomplete writes and HID errors fail explicitly", async () => {
  const cases = [
    (report, self) => {
      const packet = response(report[1], Buffer.from([1]));
      packet[5] ^= 1;
      self.emit("data", packet);
    },
    (report, self) => {
      self.emit("data", response(report[1], Buffer.from([1]), 2));
      self.emit("data", response(report[1], Buffer.from([2]), 0));
    },
    (_report, self) => self.emit("error", new Error("unplugged")),
  ];
  for (const [index, reply] of cases.entries()) {
    const dock = new Dock(new FakeHid(reply), {});
    await assert.rejects(dock.query(PORTS.host), [/checksum/, /Out-of-order/, /unplugged/][index]);
    await dock.close();
  }
  const device = new FakeHid();
  device.write = async () => 63;
  const dock = new Dock(device, {});
  await assert.rejects(dock.query(PORTS.host), /Incomplete/);
  await dock.close();
  const throwingDevice = new FakeHid();
  throwingDevice.write = () => { throw new Error("write failed"); };
  const throwingDock = new Dock(throwingDevice, {});
  await assert.rejects(throwingDock.query(PORTS.host), /write failed/);
  await throwingDock.close();
});

test("concurrent queries and use after close are rejected", async () => {
  const dock = new Dock(new FakeHid(), {});
  const pending = dock.query(PORTS.host);
  await assert.rejects(dock.query(PORTS.usb_c2), /Concurrent/);
  await dock.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(dock.query(PORTS.host), /closed/);
});

test("removes HID listeners before closing the native handle", async () => {
  const device = new FakeHid();
  let resumes = 0;
  device.on("newListener", eventName => {
    if (eventName === "data") {
      process.nextTick(() => {
        if (device.listenerCount("data") === 0) return;
        resumes++;
        if (device.closed) throw new Error("device has been closed");
      });
    }
  });
  const dock = new Dock(device, {});
  await dock.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumes, 0);
  assert.equal(device.listenerCount("data"), 0);
  assert.equal(device.listenerCount("error"), 0);
});

test("snapshot includes every port, correct units and USB identity without firmware assumptions", async () => {
  const device = new FakeHid((report, self) => {
    const port = report[1];
    const data = port <= 4 ? Buffer.from([1, 18, 0, 0x4e, 0x20, 0x0b, 0xb8])
      : port === PORTS.ethernet ? Buffer.from([1, 3]) : Buffer.from([0]);
    self.emit("data", response(port, data));
  });
  const dock = new Dock(device, { product: "A83B3", serialNumber: "test", release: 512 });
  const snapshot = await dock.snapshot();
  assert.deepEqual(Object.keys(snapshot.ports), Object.keys(PORTS));
  assert.equal(snapshot.ports.host.power_w, 60);
  assert.equal(snapshot.device.model, "A83B3");
  assert.equal(snapshot.device.serial, "test");
  assert.equal(snapshot.device.usb_release, 512);
  assert.equal("firmware" in snapshot.device, false);
  assert.ok(Number.isFinite(Date.parse(snapshot.timestamp)));
  await dock.close();
});

test("per-port broker gate stops a snapshot without sending another HID request", async () => {
    let allowed = true;
    let writes = 0;
    const device = new FakeHid((report, self) => {
      writes++;
      self.emit("data", response(report[1], Buffer.from([1, 18, 0, 0x4e, 0x20, 0x0b, 0xb8])));
      allowed = false;
    });
    const dock = new Dock(device, {});
    await assert.rejects(dock.snapshot({ shouldQuery: () => allowed }), /paused/);
    assert.equal(writes, 1);
    await dock.close();
});

test("MQTT disconnect cancellation rejects an outstanding HID read without waiting for timeout", async () => {
    let writes = 0;
    const controller = new AbortController();
    const device = new FakeHid(() => {
      writes++;
      controller.abort();
    });
    const dock = new Dock(device, {});
    await assert.rejects(dock.snapshot({ signal: controller.signal }), /cancelled/);
    assert.equal(writes, 1);
    assert.equal(dock.pending, null);
    await dock.close();
});

test("gate is checked immediately before deferred HID write, not just at query entry", async () => {
    let allowed = true;
    let writes = 0;
    const device = new FakeHid(() => { writes++; });
    const dock = new Dock(device, {});
    const pending = dock.query(PORTS.host, 3000, { shouldQuery: () => allowed });
    allowed = false;
    await assert.rejects(pending, /paused/);
    assert.equal(writes, 0);
    await dock.close();
});

test("recognizes a dock held exclusively by Anker Dock Manager", () => {
  const mac = new Error("cannot open device with path DevSrvsID:4295463259: hid_open_path: failed to open IOHIDDevice from mach entry: (0xE00002C5) (iokit/common) exclusive access and device already open");
  assert.equal(isDockBusyError(mac), true);
  assert.equal(isDockBusyError(new Error("The process cannot access the file because it is being used by another process")), true);
  assert.equal(isDockBusyError(new Error("A83B3 HID interface not found")), false);
  const busy = new DockBusyError(mac);
  assert.equal(busy.code, "DOCK_BUSY");
  assert.equal(busy.cause, mac);
  assert.match(busy.message, /Anker Dock Manager/);
});

test("an unplugged dock is reported as disconnected, not as a generic error", () => {
  assert.equal(new DockNotFoundError().code, "DOCK_NOT_FOUND");
  assert.equal(isDockMissingError(new DockNotFoundError()), true);
  assert.equal(isDockMissingError(new Error("could not read from HID device")), true);
  assert.equal(isDockMissingError(new Error("Timed out reading port 0x1")), false);
  assert.equal(isDockBusyError(new DockNotFoundError()), false);
});
