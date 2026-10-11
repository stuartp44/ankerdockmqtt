import { createHash } from "node:crypto";

// The bridge publishes lowercase machine values on <prefix>/dock; Home Assistant shows these labels.
const DOCK_CONNECTION_LABELS = {
  connected: "Connected", disconnected: "Unplugged", busy: "In use by another app", error: "Error",
};
const DOCK_CONNECTION_TEMPLATE = `{{ ${JSON.stringify(DOCK_CONNECTION_LABELS)}.get(value, value) }}`;

export function discoveryMessages(snapshot, topic, prefix = "homeassistant") {
  if (!snapshot.device?.model) throw new Error("Device identity is required for MQTT discovery");
  const identity = snapshot.device.serial || topic;
  const id = `anker_a83b3_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  const device = {
    identifiers: [id],
    name: "Anker Prime Dock",
    manufacturer: "Anker",
    model: snapshot.device.model,
    ...(snapshot.device.serial ? { serial_number: snapshot.device.serial } : {}),
  };
  const entities = [];
  // Telemetry is only valid while both the laptop bridge (broker last will) and the dock reading are online.
  const telemetryAvailability = {
    availability: [{ topic: `${topic}/bridge` }, { topic: `${topic}/availability` }],
    availability_mode: "all",
    payload_available: "online",
    payload_not_available: "offline",
  };
  function add(component, key, name, template, properties = {}, availability = telemetryAvailability) {
    entities.push({
      topic: `${prefix}/${component}/${id}/${key}/config`,
      payload: {
        name,
        unique_id: `${id}_${key}`,
        state_topic: `${topic}/state`,
        value_template: template,
        ...availability,
        device,
        origin: { name: "Dock MQTT", sw_version: "0.2.0" },
        ...properties,
      },
    });
  }
  for (const [port, label] of [
    ["host", "Laptop"], ["usb_c2", "USB-C 2"], ["usb_c3", "USB-C 3"], ["usb_c4", "USB-C 4"],
  ]) {
    const portIcon = port === "host" ? "mdi:laptop" : "mdi:usb-c-port";
    for (const [field, name, unit, deviceClass] of [
      ["power_w", "power", "W", "power"],
      ["voltage_v", "voltage", "V", "voltage"],
      ["current_a", "current", "A", "current"],
    ]) {
      add("sensor", `${port}_${field}`, `${label} ${name}`,
        `{{ value_json.ports.${port}.${field} }}`,
        { unit_of_measurement: unit, device_class: deviceClass, state_class: "measurement" });
    }
    add("sensor", `${port}_protocol`, `${label} charging protocol`,
      `{{ value_json.ports.${port}.charging_protocol }}`, { icon: "mdi:battery-charging-high" });
    add("binary_sensor", `${port}_connected`, `${label} connected`,
      `{{ 'ON' if value_json.ports.${port}.status > 0 else 'OFF' }}`,
      { device_class: "connectivity", payload_on: "ON", payload_off: "OFF", icon: portIcon });
  }
  for (const [port, label, icon] of [
    ["hdmi1", "HDMI 1", "mdi:video-input-hdmi"], ["hdmi2", "HDMI 2", "mdi:video-input-hdmi"],
    ["displayport", "DisplayPort", "mdi:monitor"],
  ]) {
    add("binary_sensor", `${port}_connected`, `${label} connected`,
      `{{ 'ON' if value_json.ports.${port}.connected else 'OFF' }}`,
      { device_class: "connectivity", payload_on: "ON", payload_off: "OFF", icon });
  }
  add("sensor", "upstream_link", "Host USB link", "{{ value_json.ports.upstream.link }}",
    { icon: "mdi:usb" });
  add("sensor", "host_driver", "Host driver", "{{ value_json.ports.host_driver.driver }}",
    { entity_category: "diagnostic", icon: "mdi:chip" });
  add("sensor", "ethernet_bandwidth", "Ethernet link speed",
    "{{ value_json.ports.ethernet.max_bandwidth_mbps }}",
    { unit_of_measurement: "Mbps", icon: "mdi:speedometer" });
  add("binary_sensor", "ethernet_connected", "Ethernet connected",
    "{{ 'ON' if value_json.ports.ethernet.status > 0 else 'OFF' }}",
    { device_class: "connectivity", payload_on: "ON", payload_off: "OFF", icon: "mdi:ethernet" });
  add("binary_sensor", "bridge_connected", "Laptop bridge", undefined,
    { state_topic: `${topic}/bridge`, device_class: "connectivity", payload_on: "online", payload_off: "offline",
      icon: "mdi:lan-connect" },
    {});
  add("sensor", "dock_connection", "Dock connection", DOCK_CONNECTION_TEMPLATE,
    { state_topic: `${topic}/dock`, device_class: "enum", options: Object.values(DOCK_CONNECTION_LABELS),
      icon: "mdi:connection" },
    { availability_topic: `${topic}/bridge`, payload_available: "online", payload_not_available: "offline" });
  add("sensor", "last_update", "Last update", "{{ value_json.timestamp }}",
    { device_class: "timestamp", entity_category: "diagnostic" },
    {});
  const diagnostics = { state_topic: `${topic}/diagnostics`, entity_category: "diagnostic" };
  add("sensor", "bridge_connected_since", "Broker connected since", "{{ value_json.connected_at }}",
    { ...diagnostics, device_class: "timestamp" }, {});
  add("sensor", "last_broker_message", "Last broker message", "{{ value_json.last_broker_message_at }}",
    { ...diagnostics, device_class: "timestamp", icon: "mdi:message-arrow-left-outline" }, {});
  add("sensor", "bridge_status", "Bridge status", "{{ value_json.status }}",
    { ...diagnostics, json_attributes_topic: `${topic}/diagnostics`, icon: "mdi:information-outline" }, {});
  add("sensor", "last_error", "Last error", "{{ value_json.last_error or 'None' }}",
    { ...diagnostics, icon: "mdi:alert-circle-outline" }, {});
  for (const entity of entities) {
    if (entity.payload.value_template === undefined) delete entity.payload.value_template;
  }
  return entities;
}
