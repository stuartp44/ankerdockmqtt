export const VENDOR_ID = 0x291a;
export const PRODUCT_ID = 0x03b3;
export const USAGE_PAGE = 0xff00;
export const REPORT_ID = 0x95;
export const INFO_COMMAND = 0x66;

export const PORTS = Object.freeze({
  host: 0x01,
  usb_c2: 0x02,
  usb_c3: 0x03,
  usb_c4: 0x04,
  hdmi1: 0x11,
  hdmi2: 0x12,
  displayport: 0x13,
  upstream: 0x14,
  host_driver: 0x15,
  ethernet: 0x21,
});

const CHARGING_PROTOCOLS = [
  "NONE", "QC2.0", "QC3.0", "QC3+", "SFCP", "AFC", "FCP", "SCP",
  "VOOC1.0", "VOOC4.0", "SuperVooc2.0", "TFCP", "UFCS", "PE1.0", "PE2.0",
  "PD fixed 5V", "PD fixed high voltage", "PD SPR AVS", "PD PPS",
  "PD EPR high voltage", "PD EPR AVS",
];

function checksum(bytes) {
  return bytes.reduce((result, byte) => result ^ byte, 0);
}

export function infoRequest(port) {
  if (!Object.values(PORTS).includes(port)) {
    throw new Error(`Unsupported telemetry port: ${port}`);
  }
  const report = Buffer.alloc(64);
  report.set([REPORT_ID, port, INFO_COMMAND, 0, 6]);
  report[5] = checksum(report.subarray(0, 5));
  return report;
}

export function parseReport(report) {
  if (!Buffer.isBuffer(report) || report.length < 6 || report.length > 64) {
    throw new Error("Invalid HID report size");
  }
  if (report[0] !== REPORT_ID) throw new Error("Unexpected HID report ID");
  const size = report[4];
  if (size < 6 || size > report.length) throw new Error("Invalid packet length");
  if (checksum(report.subarray(0, size - 1)) !== report[size - 1]) {
    throw new Error("HID packet checksum mismatch");
  }
  return {
    port: report[1],
    command: report[2],
    remaining: report[3],
    payload: report.subarray(5, size - 1),
  };
}

function requireLength(data, length, name) {
  if (data.length < length) throw new Error(`Truncated ${name} telemetry`);
}

function enumValue(values, code) {
  return values[code] ?? `unknown (${code})`;
}

export function decodePort(name, data) {
  if (!(name in PORTS)) throw new Error(`Unknown port: ${name}`);
  requireLength(data, 1, name);
  const status = data[0];
  if (["host", "usb_c2", "usb_c3", "usb_c4"].includes(name)) {
    requireLength(data, 7, name);
    const voltage = data.readUInt16BE(3) / 1000;
    const current = data.readUInt16BE(5) / 1000;
    return {
      status,
      charging_protocol_code: data[1],
      charging_protocol: enumValue(CHARGING_PROTOCOLS, data[1]),
      voltage_v: voltage,
      current_a: current,
      power_w: Math.round(voltage * current * 10) / 10,
    };
  }
  if (name === "ethernet") {
    requireLength(data, 2, name);
    return {
      status,
      bandwidth_code: data[1],
      max_bandwidth_mbps: [0, 10, 100, 1000, 2500][data[1]] ?? null,
    };
  }
  if (name === "upstream") {
    return { status, link: enumValue(["disconnected", "LS", "FS", "HS", "SS", "SS+"], status) };
  }
  if (name === "host_driver") {
    return {
      status,
      driver: enumValue(["not present", "present, not connected", "present and connected"], status),
    };
  }
  if (status === 0) return { status, connected: false };
  requireLength(data, name === "displayport" ? 33 : 38, name);
  const manufacturer = data.readUInt16LE(1);
  const manufacturerLetters = [10, 5, 0].map(shift => (manufacturer >> shift) & 31);
  if (manufacturerLetters.some(letter => letter < 1 || letter > 26)) {
    throw new Error(`Invalid display manufacturer for ${name}`);
  }
  const result = {
    status,
    connected: true,
    manufacturer: manufacturerLetters.map(letter => String.fromCharCode(64 + letter)).join(""),
    product_code: data.subarray(3, 5).toString("hex").toUpperCase(),
    width_px: data.readUInt16BE(5),
    height_px: data.readUInt16BE(7),
    native_width_px: data.readUInt16BE(10),
    native_height_px: data.readUInt16BE(12),
    native_refresh_hz: data.readUInt16BE(14) / 100,
    name: data.toString("utf8", 18, 31).replace(/\0/g, "").trim(),
    refresh_hz: data.length >= (name === "displayport" ? 35 : 40)
      ? data.readUInt16BE(name === "displayport" ? 33 : 38)
      : data[9],
  };
  if (name === "displayport") {
    result.lane_count = data[31];
    result.link_rate = enumValue(["none", "1.62 Gbps", "2.7 Gbps", "5.4 Gbps", "8.1 Gbps"], data[32]);
  } else {
    result.scrambler_enabled = Boolean(data[31] & 1);
    result.clock_detected = Boolean(data[31] & 2);
    result.channel_locks = [4, 8, 16].map(mask => Boolean(data[31] & mask));
  }
  return result;
}
