import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePort, infoRequest, parseReport, PORTS } from "../src/protocol.js";

function response(port, payload, remaining = 0) {
  const report = Buffer.alloc(64);
  report.set([0x95, port, 0x66, remaining, payload.length + 6]);
  report.set(payload, 5);
  report[payload.length + 5] = report.subarray(0, payload.length + 5)
    .reduce((sum, byte) => sum ^ byte, 0);
  return report;
}

test("only known status queries can be encoded; exact 64-byte wire format", () => {
  const request = infoRequest(PORTS.host);
  assert.equal(request.length, 64);
  assert.equal(request.subarray(0, 6).toString("hex"), "9501660006f4");
  assert.ok(request.subarray(6).every(byte => byte === 0));
  assert.throws(() => infoRequest(0x20), /Unsupported/);
});

test("response framing ignores padding and preserves fragment countdown", () => {
  const report = response(PORTS.host, Buffer.from([1, 18, 0, 0x4e, 0x20, 0x0b, 0xb8]), 1);
  const parsed = parseReport(report);
  assert.equal(parsed.port, PORTS.host);
  assert.equal(parsed.command, 0x66);
  assert.equal(parsed.remaining, 1);
  assert.deepEqual(parsed.payload, report.subarray(5, 12));
});

test("malformed packet sizes, IDs and checksums are rejected", () => {
  assert.throws(() => parseReport(Buffer.alloc(5)), /size/);
  assert.throws(() => parseReport(Buffer.alloc(65)), /size/);
  assert.throws(() => parseReport(Buffer.alloc(6)), /ID/);
  for (const size of [0, 5, 65]) {
    const report = response(PORTS.host, Buffer.alloc(0));
    report[4] = size;
    assert.throws(() => parseReport(report), /length/);
  }
  const report = response(PORTS.host, Buffer.from([1]));
  report[5] ^= 1;
  assert.throws(() => parseReport(report), /checksum/);
});

test("USB-C telemetry uses big-endian millivolts/milliamps and watts", () => {
  const info = decodePort("host", Buffer.from([1, 18, 0, 0x4e, 0x20, 0x0b, 0xb8]));
  assert.deepEqual(info, {
    status: 1, charging_protocol_code: 18, charging_protocol: "PD PPS",
    voltage_v: 20, current_a: 3, power_w: 60,
  });
  const fractional = decodePort("usb_c2", Buffer.from([0, 255, 0, 0x13, 0x88, 0, 123]));
  assert.equal(fractional.voltage_v, 5);
  assert.equal(fractional.current_a, 0.123);
  assert.equal(fractional.power_w, 0.6);
  assert.equal(fractional.charging_protocol, "unknown (255)");
  assert.throws(() => decodePort("host", Buffer.alloc(6)), /Truncated/);
});

test("link, driver and Ethernet status retain unknown raw codes", () => {
  assert.deepEqual(decodePort("ethernet", Buffer.from([1, 3])), {
    status: 1, bandwidth_code: 3, max_bandwidth_mbps: 1000,
  });
  assert.equal(decodePort("ethernet", Buffer.from([1, 255])).max_bandwidth_mbps, null);
  assert.equal(decodePort("upstream", Buffer.from([5])).link, "SS+");
  assert.equal(decodePort("host_driver", Buffer.from([2])).driver, "present and connected");
  assert.equal(decodePort("upstream", Buffer.from([99])).link, "unknown (99)");
  assert.throws(() => decodePort("ethernet", Buffer.alloc(1)), /Truncated/);
  assert.throws(() => decodePort("bogus", Buffer.alloc(1)), /Unknown/);
});

test("display decoding handles disconnection, resolution and old/new refresh fields", () => {
  assert.deepEqual(decodePort("hdmi1", Buffer.from([0])), { status: 0, connected: false });
  const data = Buffer.alloc(40);
  data[0] = 1;
  data.writeUInt16LE((4 << 10) | (5 << 5) | 12, 1);
  data.writeUInt16BE(3840, 5);
  data.writeUInt16BE(2160, 7);
  data[9] = 60;
  data.writeUInt16BE(3840, 10);
  data.writeUInt16BE(2160, 12);
  data.writeUInt16BE(6000, 14);
  data.write("Test Monitor", 18);
  data[31] = 31;
  data.writeUInt16BE(120, 38);
  const decoded = decodePort("hdmi1", data);
  assert.equal(decoded.manufacturer, "DEL");
  assert.equal(decoded.width_px, 3840);
  assert.equal(decoded.height_px, 2160);
  assert.equal(decoded.native_refresh_hz, 60);
  assert.equal(decoded.refresh_hz, 120);
  assert.equal(decoded.name, "Test Monitor");
  assert.deepEqual(decoded.channel_locks, [true, true, true]);
  assert.equal(decodePort("hdmi1", data.subarray(0, 38)).refresh_hz, 60);
  data[31] = 4;
  data[32] = 3;
  data.writeUInt16BE(144, 33);
  assert.equal(decodePort("displayport", data.subarray(0, 35)).refresh_hz, 144);
  assert.equal(decodePort("displayport", data.subarray(0, 35)).link_rate, "5.4 Gbps");
  assert.throws(() => decodePort("hdmi1", Buffer.from([1])), /Truncated/);
});
