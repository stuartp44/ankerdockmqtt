# Anker dock MQTT bridge

Read-only telemetry for the **[Anker Prime Docking Station (14-in-1, Triple
Display, DisplayLink)](https://www.anker.com/products/a83b3-anker-prime-charging-docking-station-14-in-1-triple-display-140w)**,
model **A83B3** (USB IDs `291a:03b3` for telemetry, `17e9:7000` for
DisplayLink). This is not a generic bridge for every Anker 14-in-1 model.

This is an independent project. It is not affiliated with, endorsed by, or
supported by Anker. Anker and Anker Prime are trademarks of their owner.

The bridge runs on the computer physically connected to the dock. It replaces
Dock Manager's telemetry polling, not the DisplayLink driver. Keep DisplayLink
Manager installed/running if your displays need it.

## Desktop app (macOS and Windows)

**Dock MQTT** is an Electron tray/menu-bar app. Packaged apps include their
runtime; users do not need to install Node.js.

- macOS: unzip the package and move **Dock MQTT.app** into Applications.
- Windows: run **Dock MQTT Setup** to install the app for your user account.
- Open **Settings and telemetry** from the tray/menu-bar icon.
- Enter the broker URL, optional credentials, topic prefix, polling interval,
  and optionally the dock serial. Click **Save settings**, then **Start bridge**.
- **Stop bridge** releases the USB device and publishes offline availability.
  Stop before editing settings or refreshing device enumeration.
- Closing the window leaves the app running in the tray/menu bar. Use **Quit
  Dock MQTT** from the tray menu to exit.
- **Connect automatically when this app opens** is opt-in and starts the bridge
  whenever the app launches.
- **Start Dock MQTT when I log in** adds the app to macOS Login Items or the
  Windows per-user startup (Run) entry. It applies immediately, is stored by the
  OS rather than the settings file, and opens the app in the tray/menu bar
  without showing the window. Enable **Connect automatically** too, so the
  bridge starts after login; it still waits until the broker is reachable. On
  macOS, if System Settings > General > Login Items requires approval, the
  window says so. Turn the option off in the app to remove the login item.

The window displays connection/error status, charging power, host-link status,
Ethernet status, and the complete timestamped JSON snapshot. Settings persist
in Electron's per-user application data directory. Passwords are encrypted
using Electron safeStorage (macOS Keychain / Windows DPAPI), are never returned
to the renderer, and are not saved if OS encryption is unavailable. Leave the
password field blank to retain a saved password, or select **Clear saved
password** to remove it. Do not put credentials in the broker URL.
macOS may ask for your login Keychain password or approval when credentials are
first saved or read, particularly with unsigned builds. While that system prompt
is pending, the app may appear unresponsive. Approve it only for the Dock MQTT
build you trust; enter your Keychain password in the macOS dialog, never in the
broker password field. The desktop smoke test allows extra time for approval.

On macOS 15 and later, connecting to a broker on your LAN (for example
`mqtt://192.168.x.x:1883`) requires **Local Network** permission. The app
declares `NSLocalNetworkUsageDescription`, and macOS asks the first time you
connect. If you denied it, or the connection fails with `EHOSTUNREACH` / "No
route to host" while other apps can reach the broker, enable **Dock MQTT** in
System Settings > Privacy & Security > Local Network, then reconnect. Loopback
brokers (`127.0.0.1`) do not need this permission, so the automated tests do
not exercise it.

A **paused** status with `Connection refused: Not authorized` means the broker
was reached but rejected the username or password. Home Assistant's Mosquitto
add-on accepts Home Assistant users (Settings > People > Users) or accounts in
the add-on's `logins` option; re-enter the password in Dock MQTT afterwards.

Without a Developer ID, macOS builds are re-signed ad hoc after packaging
(`build/after-pack.cjs`) so their code identity is `io.ankerdockmqtt.desktop`
rather than Electron's default linker signature. Local Network privacy also
identifies programs by their Mach-O UUID (Apple TN3179). Electron's prebuilt
executables share one UUID in every Electron app, so macOS would otherwise
confuse Dock MQTT with `Electron.app` and never prompt for it. The same hook
gives each packaged executable a stable, app-specific UUID before signing. If
an old `Electron.app` entry appears in Local Network settings, it is not Dock
MQTT and can be ignored.

These initial packages are **unsigned and not notarized**. macOS Gatekeeper or
Windows SmartScreen may warn. Production distribution requires the appropriate
Apple Developer ID/notarization credentials and Windows signing certificate;
none are included in this project.

### Develop and package

Requires Node.js 24+ for development:

```sh
npm ci
npm run app
npm run dist:mac -- --arm64
npm run dist:mac -- --x64
npm run dist:win -- --x64
```

Packages are written to `dist/`: macOS ZIP archives containing the app and a
Windows x64 NSIS installer. macOS packaging uses ZIP rather than mounting disk
images. The native HID dependency ships platform-specific N-API prebuilds;
packaging includes those binaries instead of attempting cross-platform C++
source compilation. Local `node-hid/build` outputs are excluded so they cannot
override another platform's prebuilt binary. The macOS/Windows build workflow can produce unsigned
packages after this project is published to GitHub.

```sh
npm test
npm run test:desktop
# After producing all three platform/architecture app folders:
npm run test:packages
```

### Releases and verified updates

[Release Please](.github/workflows/release-please.yml) runs on pushes to
`main` and maintains a release PR using Conventional Commit messages:
`fix:` for bug fixes, `feat:` for features, and `BREAKING CHANGE:` for breaking
changes. The PR updates `package.json`, `package-lock.json`, `CHANGELOG.md`,
and the [release manifest](.release-please-manifest.json). The manifest starts
at the project's current version, `0.2.0`.

Merge the release PR to create the version tag. Release Please does not publish
a published GitHub release; it creates a draft release and directly calls the
[build workflow](.github/workflows/release.yml), which runs tests, builds
Windows x64 and macOS x64/arm64 packages, signs their SHA-256 manifest, and
attaches the packages and signature before publishing it. This direct call is
necessary because tags created with `GITHUB_TOKEN` do not trigger another push
workflow. Publishing only after the assets are ready supports GitHub's
immutable releases. No personal access token is required.
Allow GitHub Actions to create pull requests in the repository's Actions
settings.

If a build fails, run the build workflow manually against the existing tag to
retry. Manual tag pushes remain supported, but their versions must match
`package.json`.

Before publishing the first release, create an Ed25519 update-signing key pair:

```sh
npm run updates:keygen
```

Create a GitHub Actions environment named `release`, allow deployments from
`main` (for Release Please's reusable workflow) and version tags matching `v*`
(for manual/tag-triggered releases), and require maintainer approval. Every
build checks out the specified version tag. Add the private key as an
environment secret:

```sh
gh secret set UPDATE_SIGNING_PRIVATE_KEY --env release < update-signing-private.pem
```

Commit `desktop/update-signing-public.pem`; never commit or distribute
`update-signing-private.pem`. The release workflow refuses to publish if the
environment secret or matching pinned public key is missing. The app refuses
to offer packages unless the manifest signature and package SHA-256 both
verify. If the signing key is lost or compromised, rotate it by shipping a new
pinned public key in a trusted app release before using the replacement key.

In **Settings and telemetry**, enable automatic stable update checks to have
Dock MQTT check for and download the latest stable GitHub release. It verifies
the signed manifest and exact SHA-256 before presenting the package for
installation. Windows shows a confirmation before launching the verified
installer. macOS downloads the verified ZIP and opens it in Finder for manual
installation because these builds are not signed or notarized. Updates are
opt-in and prereleases are never installed.
Existing installs must be manually upgraded once to a release containing the
updater and its pinned public key; older app versions cannot verify this
release format.

The desktop smoke test uses an isolated temporary settings profile and a
loopback MQTT broker. It checks the real Electron window, IPC validation,
OS-encrypted password persistence, device enumeration, and close-to-tray
behavior. Set `LIVE_DOCK=1` when explicitly testing with a connected A83B3 and
Dock Manager quit to additionally verify live telemetry and stop behavior.
`APP_EXECUTABLE` selects an already packaged app executable for this smoke test.
The package smoke test inspects all three ASAR archives, confirms the app entry
points, checks native PE/Mach-O architectures, and rejects locally compiled HID
fallbacks that could break cross-platform packaging.

## Command-line setup

The existing command-line interface is still available. It requires Node.js
24+ and USB HID access.

```sh
npm ci
npm run list
```

Quit Anker Dock Manager before polling: simultaneous clients can contend for the
HID interface or consume each other's responses. Never run the bridge during a
firmware update. On macOS, Dock Manager opens the dock exclusively; while it is
running, the bridge reports status **busy** (`The dock is in use by another
app…`), publishes `offline` availability, and retries every polling interval.
It resumes automatically once Dock Manager is quit. Note that while Dock MQTT
holds the dock, Dock Manager may likewise be unable to read it.

Read a complete live snapshot without any MQTT connection:

```sh
npm run once
```

Publish to your broker:

```sh
MQTT_URL=mqtt://broker.example:1883 npm start
```

No broker address or credentials are hardcoded. Environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `MQTT_URL` | Broker URL; required except for `--list`/`--once` | None |
| `MQTT_USERNAME` | Optional authentication username | None |
| `MQTT_PASSWORD` | Optional authentication password | None |
| `MQTT_TOPIC` | Topic prefix; use a unique prefix for each dock | `anker/dock` |
| `MQTT_CLIENT_ID` | Optional stable, unique MQTT client ID | PID-based |
| `DOCK_SERIAL` | Select a dock if several are attached | Only attached A83B3 |
| `POLL_INTERVAL_MS` | Delay between completed polls, 1000-3600000 ms | `10000` |
| `HA_DISCOVERY` | Publish Home Assistant discovery (`true`/`false`) | `true` |
| `HA_DISCOVERY_PREFIX` | Home Assistant discovery topic prefix | `homeassistant` |

Use `mqtts://` with a trusted certificate for encrypted transport. Do not commit
credentials. Environment files are not loaded automatically.

## Home Assistant MQTT discovery

Enabled by default, including for settings saved by version 0.1.0. Configure
Home Assistant's MQTT integration to use the **same broker** as Dock MQTT.
Leave **Set up Home Assistant MQTT discovery automatically** checked, save the
settings, and start the bridge. After the first complete dock reading,
**Anker Prime Dock** appears under MQTT in **Settings > Devices & services**.
The application publishes retained discovery configs; no manual YAML is needed.

One device contains 34 entities: laptop/USB-C power, voltage, current, charging
protocol and connection status, display connection status, host USB link/driver
and Ethernet status/bandwidth, plus connection diagnostics:

| Entity | Source | Purpose |
| --- | --- | --- |
| **Laptop bridge** (connectivity) | `<prefix>/bridge` | `Off` when the laptop drops off the broker (broker last will) or stops the bridge |
| **Dock connection** | `<prefix>/dock` | Shown as **Connected**, **Unplugged** (dock unplugged from the laptop), **In use by another app** or **Error** |
| **Last update** (diagnostic) | `<prefix>/state` | Time of the last dock reading; stays visible while offline |
| **Broker connected since**, **Last broker message**, **Bridge status**, **Last error** (diagnostic) | `<prefix>/diagnostics` | When the bridge connected, when the broker last sent it anything, and why it is not online |

Every entity without a numeric or timestamp device class has its own Material
Design icon (for example `mdi:usb-c-port`, `mdi:video-input-hdmi`,
`mdi:ethernet`), so none fall back to Home Assistant's generic eye icon.

Telemetry entities require both `<prefix>/bridge` and `<prefix>/availability`
to be `online` (`availability_mode: all`), so they become unavailable when the
laptop disappears or the dock cannot be read. The diagnostic entities have no
availability, so their last values remain visible for troubleshooting.
Entity IDs use a stable hash of the dock serial, not the process ID; a topic
change does not create another device. Docks without a serial use the topic
prefix as their identity, so keep that prefix stable.

Discovery uses `<discovery-prefix>/<component>/<device-id>/<entity>/config`,
QoS 1 and retain. It is republished after broker reconnect and Home Assistant's
`<discovery-prefix>/status` birth message `online`. If HA uses a custom discovery
prefix, enter that prefix in the app too. Broker permissions must allow
publishing discovery/state/availability/bridge/dock/diagnostics and subscribing to the HA status topic.
Disabling discovery stops future announcements; it does not delete retained
configs already on your broker.

## Disconnection and network gating

The selected network policy is **configured broker connectivity**, not an SSID
or subnet allowlist. The bridge makes no automatic USB opens or status requests
until an authenticated MQTT connection to that broker is established. When
MQTT disconnects, the app shows **Paused**, cancels the pending status read,
closes the dock handle and sends no further status requests. The broker's last
will sets `<prefix>/bridge` to `offline`, which shows **Laptop bridge** as
disconnected and marks the telemetry entities unavailable. MQTT reconnects every 5 seconds; after
reconnecting, the app reopens the dock and publishes discovery and fresh data.

Broker access is checked before each port request and again before sending its
HID report, not only at the start of a poll. Requests already submitted to USB
cannot be retracted. Network loss is detected by the MQTT socket/10-second
keepalive (not instant Wi-Fi detection), so an undetected network failure can
continue polling until MQTT reports disconnection. A broker reachable over a
VPN or the internet also permits polling; use a local-only broker if that is
not intended. Broker authentication/TLS is the trust mechanism, not Wi-Fi names.

If the dock is unplugged but MQTT is connected, the app shows **disconnected**,
publishes `disconnected` to `<prefix>/dock`, marks telemetry offline and
releases the failed handle. `<prefix>/bridge` stays `online`, so Home Assistant
can tell "dock unplugged from the laptop" apart from "laptop gone". Reconnecting the dock is retried on the polling
interval. Stopping the bridge cancels pending reads and reconnect attempts.
The explicit CLI `--once`/`--list` commands and the UI **Find dock** action are
manual diagnostics and do not require a broker.

## MQTT

- `<prefix>/state`: retained JSON, QoS 1. Timestamp, USB device information, and
  a `ports` object with host charging, USB-C2/C3/C4, HDMI1/2, DisplayPort, upstream
  USB link, host driver, and Ethernet data.
- `<prefix>/availability`: retained `online`/`offline`, QoS 1. Online is published
  only after a complete fresh snapshot. Failed polls and stopping the bridge mark
  it offline; the previous state remains retained.
- `<prefix>/bridge`: retained `online`/`offline`, QoS 1. This is the MQTT **last
  will**: the broker publishes `offline` if the laptop disappears without a clean
  disconnect (sleep, network loss, crash; detected within about 15 seconds by the
  10-second keepalive). The bridge publishes `online` after each connection and
  `offline` when stopped cleanly.
- `<prefix>/dock`: retained `connected`/`disconnected`/`busy`/`error`, QoS 1,
  published when the dock's connection to this laptop changes.
- `<prefix>/diagnostics`: retained JSON, QoS 1, published after every reading,
  every dock failure, and on a clean stop:

  ```json
  {
    "host": "my-laptop",
    "status": "online",
    "dock": "connected",
    "connected_at": "2026-10-11T10:40:02.118Z",
    "last_published_at": "2026-10-11T10:52:12.904Z",
    "last_broker_message_at": "2026-10-11T10:52:12.611Z",
    "last_error": null,
    "updated_at": "2026-10-11T10:52:12.905Z"
  }
  ```

  `last_broker_message_at` is the last packet received from the broker
  (acknowledgement, keepalive response or subscribed message). The app shows the
  same values under **Connection diagnostics**.

Charging units are explicitly named `power_w`, `voltage_v`, and `current_a`.
Raw status and protocol codes are preserved. Unknown enum values are not
silently mapped to known values. A disconnected display has `connected: false`.
Ethernet bandwidth is the dock's negotiated link speed, not measured throughput.
`0` means the dock's Ethernet port has no link (no cable or the other end is
off); the app shows this as **No link**. The dock does not report traffic
counters, so neither does this bridge.
The USB release descriptor is **not** presented as a confirmed firmware version.

Consumers must check availability and the timestamp before using retained state.
No command topics, resets, power switching, settings writes, firmware upgrades,
or manufacturer cloud requests are implemented.

## Protocol and limitations

Observed locally with Dock Manager 1.1.6 and an A83B3:

- Vendor/product `291a:03b3`, HID vendor usage page `ff00`.
- 64-byte reports, report ID `95`.
- Header: report ID, port ID, command, fragment countdown, packet length.
- Command `66` queries port information with no request payload.
- Packet length includes the five-byte header and one-byte XOR checksum;
  trailing report padding is ignored.
- USB-C payload: status at byte 0, protocol at byte 1, millivolts as big-endian
  uint16 at byte 3, milliamps as big-endian uint16 at byte 5.

The implementation is independent and does not load or redistribute Anker's
application/native modules. A read-only query still writes a HID request packet;
it does not modify dock configuration. Protocol details may differ with firmware.
Physical USB enumeration establishes identity, not every port decoder's accuracy:
compare the live output with Dock Manager when validating a new firmware/model.

```sh
npm test
```

Tests cover framing, malformed responses, port decoding, request timeouts,
multi-report assembly, and retained MQTT publication against an in-process
broker. No physical device is needed for tests.

## Hostless operation (not supported by the dock)

Investigated on 2026-10-11 with an A83B3 on macOS. The dock cannot publish
telemetry, or be queried over the network, without a host computer attached to
its upstream USB-C port. On the host, it appears as two separate USB devices:

| Device | USB IDs | Link | Role |
|---|---|---|---|
| `A83B3_A1` (DisplayLink) | `17e9:7000` | 10 Gb/s | Video outputs and the Ethernet port, exposed to the host as a USB network adapter (`en27` on macOS) |
| `A83B3` (Anker Technology) | `291a:03b3` | 12 Mb/s | Vendor HID controller that answers this bridge's telemetry queries |

- The Ethernet port is a USB network adapter for the host. All traffic goes
  through the host's network stack, and the dock has no IP address, network
  service, or embedded network stack of its own.
- The telemetry controller is a separate low-speed HID device. It only responds
  to requests from the host and has no path to the Ethernet chip.
- Neither Dock Manager 1.1.6 nor the HID protocol contains network or cloud
  telemetry for the dock. Firmware updates also go through the host over USB.
- With no host attached, the dock still passes through power, but nothing
  queries the controller, so no telemetry is available.

While the laptop is undocked, the bridge pauses and Home Assistant shows the
entities as unavailable. That is the correct state for this dock. Options when
data is needed without the laptop:

1. **Laptop as host (current design):** telemetry is available only while
   docked.
2. **Always-on host:** connect the dock's upstream port to a Raspberry Pi or
   mini PC running the command-line bridge (`npm start`) with `node-hid`. That
   computer then becomes the dock's host instead of the laptop, so this only
   suits a fixed setup.
3. **External power metering:** a smart plug with energy monitoring on the
   dock's power supply gives total power in Home Assistant whether or not a
   host is attached, but no per-port data.

## Initial validation

Validated on macOS with the connected A83B3 on 2026-10-10:

- `npm run list`: passed; found the `291a:03b3` management interface.
- `npm run once`: passed with Dock Manager quit; decoded all 10 port/status
  entries, including laptop charging, two connected HDMI displays, a
  SuperSpeed+ upstream link, and 1 Gbps Ethernet status.
- `npm test`: passed, 34 tests, including discovery, offline query gating,
  cancellation, reconnect/reattachment, desktop settings and shared-service
  lifecycle coverage.
- An additional live end-to-end check launched the bridge against a temporary
  loopback MQTT broker and verified that a subscriber received a physical dock
  snapshot and online status. SIGTERM published offline and exited with code 0.

Desktop validation on the same Mac:

- Apple Silicon macOS ZIP packaging: passed.
- Packaged macOS app smoke test with `LIVE_DOCK=1`: passed. Verified the actual
  window, OS-encrypted settings, physical USB telemetry to a loopback MQTT
  broker, Start/Stop controls, and close-to-tray behavior.
- Intel macOS package smoke test under Rosetta with `LIVE_DOCK=1`: passed after
  macOS Keychain approval. This does not replace testing on a physical Intel Mac.
- `npm run test:packages`: passed for Windows x64, macOS Intel, and macOS Apple
  Silicon; verified entry points and native HID binary architecture.
- Windows x64 NSIS cross-packaging: passed using bundled Windows N-API binaries.
  Windows installation, DPAPI, tray behavior, and physical USB communication
  still require verification on a Windows machine.

Version 0.2.0 adds retained Home Assistant discovery and broker-based polling
gating. Live desktop validation with a loopback broker confirmed all 27
discovery entities, Paused status on MQTT disconnection, automatic resumption
with the same identities, and clean Stop. Home Assistant itself was not running
in this test; discovery payloads and retained delivery were checked against
the documented MQTT discovery format.

No permanent broker, startup service, external MQTT connection, or real broker
credentials were configured. Temporary smoke-test profiles are removed on exit.

## License

This project is licensed under the [MIT License](LICENSE).
Third-party dependencies retain their own licenses.
