// Bluetooth and USB serial connection management. Both transports produce
// the same shape -- { kind, transport, device, ...transport-specific ref }
// -- so the rest of the app (main.js's reconnect/capture logic) can stay
// mostly transport-agnostic; only connectNew*()/reconnect*() differ.
//
// TransportWebBluetooth.create() (the one-shot helper) internally does
// `navigator.bluetooth.requestDevice(...)` and never hands back the
// resulting BluetoothDevice, which we need to keep around for
// reconnect-after-reboot. So we do the requestDevice() call ourselves
// (replicating the transport's own filter, confirmed by reading its
// bundled source: `{ filters: [{ services: [ServiceUuid] }] }`) and go
// through TransportWebBluetooth.createFromDevice() instead, so we always
// hold a stable reference to the BluetoothDevice.
import { MeshDevice } from "@meshtastic/core";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

// Web Serial (unlike Web Bluetooth) is desktop-Chromium-only -- not
// implemented on Android Chrome, Firefox, or Safari.
export function serialAvailable() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** A short label for the connection indicator / fleet-card "last connection"
 * field. Serial ports have no user-facing name in the Web Serial API (only
 * USB vendor/product IDs via getInfo()), unlike a BLE device's advertised
 * name. */
export function connectionLabel(connection) {
  if (!connection) return null;
  if (connection.kind === "serial") {
    const info = connection.port.getInfo?.() ?? {};
    const hex = (n) => (n != null ? n.toString(16).padStart(4, "0") : "????");
    return `USB serial (${hex(info.usbVendorId)}:${hex(info.usbProductId)})`;
  }
  return connection.bleDevice?.name ?? null;
}

/** Chromium's persisted-permissions API (chrome://flags/#enable-web-bluetooth-new-permissions-backend
 * on some versions). When present, a previously-granted device can be
 * looked up by name across a page reload without a new picker prompt. */
export function persistedPermissionsAvailable() {
  return bluetoothAvailable() && typeof navigator.bluetooth.getDevices === "function";
}

/** { kind: "ble", bleDevice, transport, device } */
async function fromBleDevice(bleDevice) {
  const transport = await TransportWebBluetooth.createFromDevice(bleDevice);
  const device = new MeshDevice(transport);
  return { kind: "ble", bleDevice, transport, device };
}

/** { kind: "serial", port, transport, device } */
async function fromSerialPort(port) {
  const transport = await TransportWebSerial.createFromPort(port);
  const device = new MeshDevice(transport);
  return { kind: "serial", port, transport, device };
}

/** Prompts the browser's device picker (filtered to the Meshtastic BLE
 * service) and connects. Must be called from a user gesture (a click
 * handler), per the Web Bluetooth spec. */
export async function connectNew() {
  if (!bluetoothAvailable()) {
    throw new Error("Web Bluetooth isn't available in this browser. Use Chrome or Edge on desktop or Android.");
  }
  const bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TransportWebBluetooth.ServiceUuid] }],
  });
  return fromBleDevice(bleDevice);
}

/**
 * Reconnect to a BluetoothDevice object already held from earlier in this
 * page session (e.g. the same device connectNew() returned before a write
 * that triggered a reboot). Retries because the device is briefly
 * unreachable while it reboots.
 */
export async function reconnect(bleDevice, { retries = 8, delayMs = 1500, onAttempt } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    onAttempt?.(attempt, retries);
    try {
      return await fromBleDevice(bleDevice);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error("Reconnect failed");
}

/** Prompts the browser's serial port picker and connects. No vendor/product
 * filter: Meshtastic hardware spans many different USB-serial chips
 * (native USB CDC, CP210x, CH9102, ...) with no single ID to filter on,
 * unlike Bluetooth's GATT service UUID -- so this leaves the choice to the
 * user, same as picking a port in any serial terminal. Must be called from
 * a user gesture (a click handler), per the Web Serial spec. */
export async function connectNewSerial() {
  if (!serialAvailable()) {
    throw new Error("Web Serial isn't available in this browser. Use Chrome or Edge on desktop.");
  }
  const port = await navigator.serial.requestPort();
  return fromSerialPort(port);
}

/**
 * Reconnect to a SerialPort object already held from earlier in this page
 * session (e.g. the same port connectNewSerial() returned before a write
 * that triggered a reboot). Retries because the device is briefly
 * unreachable while it reboots -- mirrors reconnect()'s BLE retry loop.
 */
export async function reconnectSerial(port, { retries = 8, delayMs = 1500, onAttempt } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    onAttempt?.(attempt, retries);
    try {
      return await fromSerialPort(port);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error("Reconnect failed");
}

/**
 * Best-effort reconnect across a page reload, when we no longer hold the
 * original BluetoothDevice object: looks the device up by its advertised
 * BLE name in the browser's persisted-permission list. Returns null (never
 * throws) if unsupported, not found, or the name has changed -- callers
 * should fall back to connectNew() in that case. NOTE: the BLE advertised
 * name can change if a write updates the device's short name, so this is
 * a convenience, not a guarantee -- prefer reconnect() with a held
 * BluetoothDevice reference whenever one is available.
 */
export async function resumeByName(bleName) {
  if (!persistedPermissionsAvailable() || !bleName) return null;
  try {
    const known = await navigator.bluetooth.getDevices();
    const match = known.find((d) => d.name === bleName);
    return match ? await fromBleDevice(match) : null;
  } catch (err) {
    console.warn("resumeByName failed", err);
    return null;
  }
}

export async function disconnect(connection) {
  if (!connection) return;
  try {
    await connection.device.disconnect();
  } catch (err) {
    console.warn("Error while disconnecting", err);
  }
}

/**
 * Performs a "1200bps touch" reset: reopen the port at 1200 baud and
 * close it again, which the Adafruit nRF52 bootloader's USB CDC stack
 * treats as a signal to reset into DFU (UF2) mode on its own -- the same
 * mechanism nrfutil/PlatformIO use before a serial firmware upload
 * (confirmed in the T1000-E's own board definition:
 * "use_1200bps_touch": true). This is independent of Meshtastic's
 * enterDfuModeRequest admin command (see MeshDevice.enterDfuMode() /
 * writer.js's handleEnterDfuMode) -- confirmed in practice that some
 * T1000-E firmware/bootloader combinations just reboot back into the
 * app instead of the bootloader when sent that command, while this
 * lower-level touch is what the device's own upload tooling relies on.
 * Only meaningful for a "serial" connection; disconnects the Meshtastic
 * session first so the port is free to reopen at a different baud rate.
 */
export async function triggerSerialDfuTouch(connection) {
  if (connection?.kind !== "serial") {
    throw new Error("The 1200bps DFU touch only applies to a USB serial connection.");
  }
  await disconnect(connection);
  await new Promise((r) => setTimeout(r, 250)); // let the OS fully release the port first
  const port = connection.port;
  await port.open({ baudRate: 1200 });
  await new Promise((r) => setTimeout(r, 100));
  await port.close();
}
