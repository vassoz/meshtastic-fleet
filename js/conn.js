// Web Bluetooth connection management.
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

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/** Chromium's persisted-permissions API (chrome://flags/#enable-web-bluetooth-new-permissions-backend
 * on some versions). When present, a previously-granted device can be
 * looked up by name across a page reload without a new picker prompt. */
export function persistedPermissionsAvailable() {
  return bluetoothAvailable() && typeof navigator.bluetooth.getDevices === "function";
}

/** { bleDevice, transport, device } */
async function fromBleDevice(bleDevice) {
  const transport = await TransportWebBluetooth.createFromDevice(bleDevice);
  const device = new MeshDevice(transport);
  return { bleDevice, transport, device };
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
