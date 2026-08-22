// Composition root: owns the single mutable app state, wires event
// delegation, and re-renders the whole #app content on every state
// change. No framework: view modules under js/ui/ each export
// render(state) -> HTML string and onAction(state, action, target, event)
// -> true|false|{asyncAction}. Text/number/select/textarea/checkbox
// inputs are read on `change` (not `input`), not `keydown` -- so a full
// innerHTML re-render never fights an in-progress keystroke or steals
// focus mid-type; the DOM is only rebuilt once a field is committed.
import * as storage from "./storage.js";
import * as shell from "./ui/shell.js";
import * as fleetView from "./ui/fleet.js";
import * as localEditor from "./ui/localEditor.js";
import * as readView from "./ui/readView.js";
import * as writeView from "./ui/writeView.js";
import * as dataView from "./ui/dataView.js";
import { Types } from "@meshtastic/core";
import { connectNew, reconnect, connectNewSerial, reconnectSerial, connectionLabel, disconnect as bleDisconnect } from "./conn.js";
import { captureSnapshot } from "./snapshot.js";
import { executeWritePlan, verifyWritePlan } from "./writer.js";
import { generatePrivateKeyBase64 } from "./keys.js";
import { listLocalProfiles, upsertLocalProfile, touch } from "./profiles.js";

const routeModules = {
  fleet: fleetView,
  local: localEditor,
  read: readView,
  write: writeView,
  data: dataView,
};

const state = {
  store: storage.load(),
  route: "fleet",
  connection: null, // { kind: "ble", bleDevice, transport, device } | { kind: "serial", port, transport, device } | null
  connectionStatus: "disconnected", // disconnected|connecting|configuring|connected|reconnecting
  liveSnapshot: null,
  ui: {
    error: null,
    notice: null,
    busy: false,
    busyMessage: "",
    selectedLocalId: null,
    revealedSecrets: new Set(),
    readMode: "global",
    readMessage: "",
    readBaselineMode: "defaults",
    readBaselineId: null,
    selectedDiffRows: new Set(),
    promoteTargetId: "new",
    writeGlobalId: null,
    writeLocalId: null,
    writePlan: null,
    writeVerify: null,
    writeLog: [],
    dataMessage: "",
  },
  render: null, // bound below, so async callbacks / other modules can trigger a repaint
};

const appEl = document.getElementById("app");

function renderApp() {
  const view = routeModules[state.route] ?? fleetView;
  appEl.innerHTML = shell.renderHeader(state) + view.render(state);
  try {
    storage.save(state.store);
  } catch (err) {
    console.error("Failed to persist store", err);
  }
}
state.render = renderApp;

function dispatch(action, target, event) {
  const view = routeModules[state.route] ?? fleetView;
  let result;
  try {
    result = shell.onAction(state, action, target, event);
    if (result === false) result = view.onAction(state, action, target, event);
  } catch (err) {
    // A synchronous bug in an onAction handler (e.g. a malformed profile
    // that fails to convert to protobuf JSON) must never look like the
    // button did nothing -- that's exactly how a real bug here presented
    // originally: buildWritePlan() threw, dispatch() had no try/catch, so
    // the exception aborted silently before reaching renderApp().
    console.error(`Action "${action}" failed`, err);
    state.ui.error = err?.message || String(err);
    renderApp();
    return;
  }

  if (result && typeof result === "object" && result.asyncAction) {
    runAsyncAction(result.asyncAction, target, event);
    return; // async handler is responsible for re-rendering
  }
  if (result) renderApp();
}

// Elements whose primary signal is `change` (checkboxes, selects, text/
// number inputs, textareas, file inputs) are handled exclusively by the
// change listener below -- routing them through click too would
// double-fire (a <select> click fires with the *pre-selection* value
// before its change event fires with the new one).
const CHANGE_DRIVEN_TAGS = new Set(["SELECT", "TEXTAREA"]);

appEl.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (CHANGE_DRIVEN_TAGS.has(target.tagName)) return;
  if (target.tagName === "INPUT" && target.type !== "button") return;
  dispatch(target.dataset.action, target, event);
});

appEl.addEventListener("change", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  dispatch(target.dataset.action, target, event);
});

async function runAsyncAction(name, target) {
  try {
    switch (name) {
      case "connect-new":
        await withTerminalConnectionStatus(handleConnectNewBle);
        break;
      case "connect-new-serial":
        await withTerminalConnectionStatus(handleConnectNewSerial);
        break;
      case "disconnect":
        await handleDisconnect();
        break;
      case "recapture":
        await withTerminalConnectionStatus(handleRecapture);
        break;
      case "generate-keypair":
        await handleGenerateKeypair(target.dataset.id);
        break;
      case "execute-write":
        await withTerminalConnectionStatus(handleExecuteWrite);
        break;
      case "factory-reset":
        await withTerminalConnectionStatus(handleFactoryReset);
        break;
      case "enter-dfu-mode":
        await withTerminalConnectionStatus(handleEnterDfuMode);
        break;
      default:
        console.warn("Unknown async action", name);
    }
  } catch (err) {
    console.error(err);
    state.ui.error = err?.message || String(err);
  } finally {
    state.ui.busy = false;
    state.ui.busyMessage = "";
    renderApp();
  }
}

// Statuses that mean "an async connection step is in flight". A handler
// that touches the BLE link must never let one of these survive past its
// own return/throw -- otherwise the header is stuck on "…" forever with
// no way to recover (this is exactly what happened when a GATT disconnect
// mid-configure threw past captureSnapshot() uncaught: busy was cleared
// but connectionStatus stayed "configuring"). Each BLE-touching handler
// below is wrapped so any error still resolves to a definite connected/
// disconnected status before it propagates.
const TRANSIENT_STATUSES = new Set(["connecting", "configuring", "reconnecting"]);

async function withTerminalConnectionStatus(fn) {
  try {
    await fn();
  } catch (err) {
    if (TRANSIENT_STATUSES.has(state.connectionStatus)) {
      state.connectionStatus = state.liveSnapshot ? "connected" : "disconnected";
    }
    throw err;
  }
}

// TransportWebBluetooth listens for the browser's `gattserverdisconnected`
// event and reports it through MeshDevice.events.onDeviceStatus as
// DeviceStatusEnum.DeviceDisconnected (confirmed in the vendored source:
// transport's onGattDisconnected -> emitStatus(...) -> MeshDevice's
// decodePacket -> updateDeviceStatus -> dispatches onDeviceStatus). But
// captureSnapshot() only subscribes to that for the duration of a single
// read -- once it resolves, nobody is listening anymore. If the BLE link
// then dies quietly while the user is just clicking around the UI (not
// mid-operation), connectionStatus stays stuck on "connected" until the
// next real device call fails outright with a raw GATT error (exactly
// what "Build plan does nothing" turned out to be: Build plan itself
// never touches the device, but the *next* Write click did, against a
// connection that had already silently died).
//
// This subscribes for the whole lifetime of a connection, not just one
// read. The tricky part: the identical DeviceDisconnected status also
// fires on a *deliberate* disconnect (transport.disconnect()'s own
// docs: "emits DeviceDisconnected('user')") and the dispatched event
// carries no reason -- onDeviceStatus.dispatch(status) drops it. So we
// can't tell the two apart from the payload; instead, every handler that
// intentionally tears down or replaces a connection sets state.ui.busy
// first, and this listener stays quiet whenever busy is true, trusting
// that handler to report its own outcome.
let stopWatchingConnection = null;

function watchConnection(connection) {
  stopWatchingConnection?.();
  stopWatchingConnection = null;
  if (!connection) return;
  stopWatchingConnection = connection.device.events.onDeviceStatus.subscribe((status) => {
    if (status !== Types.DeviceStatusEnum.DeviceDisconnected) return;
    if (state.ui.busy) return; // an in-flight handler owns this transition
    if (state.connection !== connection) return; // listener from a superseded connection
    console.warn("Device connection lost unexpectedly (gatt-disconnected)");
    state.connection = null;
    state.liveSnapshot = null;
    state.connectionStatus = "disconnected";
    state.ui.writePlan = null;
    state.ui.writeVerify = null;
    state.ui.error = "The device disconnected unexpectedly. Reconnect to continue.";
    renderApp();
  });
}

function onSnapshotProgress(label) {
  state.ui.busyMessage = `Reading: ${label}`;
  renderApp();
}

// nRF52-based Meshtastic devices (the T1000-E included) are known to drop
// the GATT connection right after the initial pairing handshake, before
// the link has settled -- the Meshtastic web client's own GitHub tracker
// has reports of exactly this. A single connect() + configure() attempt
// can therefore throw "GATT Server is disconnected..." even though the
// device is right there and otherwise fine. Retrying with a fresh GATT
// connection (same already-selected BluetoothDevice, no new picker
// prompt) papers over that instead of surfacing a dead end.
//
// The very first-ever connection to a device is a specific, worse case of
// this: the OS itself has to do a Bluetooth *bonding* handshake (the PIN
// prompt), which on Android/Windows means a system dialog the user has to
// physically notice and tap -- the GATT link stays unstable for the
// entire time that dialog is sitting there unanswered. Confirmed in
// practice: 4 attempts / ~20s total wasn't enough to survive that, but a
// second manual connect (bonding already done, no PIN prompt) worked
// first try. There's no Web Bluetooth API to detect "bonding in
// progress", so the fix is just a much bigger patience budget on every
// connection attempt, paired with an explicit "check for a pairing
// prompt" hint -- harmless for an already-bonded device, which still
// succeeds on attempt 1 with no visible delay either way.
const CONFIGURE_MAX_ATTEMPTS = 10;
const CONFIGURE_RETRY_DELAY_MS = 2000;
const RECONNECT_SUB_RETRIES = 4;
const RECONNECT_SUB_DELAY_MS = 1500;

// connRef carries whatever reconnect() needs to retry against the *same*
// physical connection -- a BluetoothDevice for kind "ble", a SerialPort for
// kind "serial" -- so this stays a single retry loop for both transports;
// only the messaging (BLE bonding/PIN prompts don't apply to serial) and
// the underlying reconnect call branch on connRef.kind.
async function captureWithRetry(connRef, { freshConnection } = {}) {
  const isSerial = connRef.kind === "serial";
  let connection = freshConnection ?? null;
  let lastErr;
  for (let attempt = 1; attempt <= CONFIGURE_MAX_ATTEMPTS; attempt++) {
    try {
      if (!connection) {
        state.ui.busyMessage = isSerial
          ? (attempt === 1 ? "Connecting…" : `Reconnecting (attempt ${attempt}/${CONFIGURE_MAX_ATTEMPTS})…`)
          : (attempt === 1
            ? "Connecting… if your device or OS shows a Bluetooth pairing/PIN prompt, accept it."
            : `Reconnecting (attempt ${attempt}/${CONFIGURE_MAX_ATTEMPTS})… if a pairing prompt appeared, accept it -- this will keep retrying.`);
        state.connectionStatus = "connecting";
        renderApp();
        connection = isSerial
          ? await reconnectSerial(connRef.port, { retries: RECONNECT_SUB_RETRIES, delayMs: RECONNECT_SUB_DELAY_MS })
          : await reconnect(connRef.bleDevice, { retries: RECONNECT_SUB_RETRIES, delayMs: RECONNECT_SUB_DELAY_MS });
      }
      state.connection = connection;
      watchConnection(connection);
      state.connectionStatus = "configuring";
      state.ui.busyMessage = "Reading device configuration…";
      renderApp();
      const snap = await captureSnapshot(connection.device, { onProgress: onSnapshotProgress, timeoutMs: 20000 });
      return { connection, snap };
    } catch (err) {
      lastErr = err;
      console.warn(`Connect/configure attempt ${attempt}/${CONFIGURE_MAX_ATTEMPTS} failed`, err);
      connection = null; // discard the broken transport; force a fresh connect next attempt
      if (attempt < CONFIGURE_MAX_ATTEMPTS) {
        state.ui.busyMessage = isSerial
          ? `Connection dropped, retrying (${attempt}/${CONFIGURE_MAX_ATTEMPTS})…`
          : `Connection dropped, retrying (${attempt}/${CONFIGURE_MAX_ATTEMPTS})… ` +
            "if this is the first time connecting to this device, watch for a pairing/PIN prompt.";
        renderApp();
        await new Promise((resolve) => setTimeout(resolve, CONFIGURE_RETRY_DELAY_MS));
      }
    }
  }
  if (isSerial) {
    throw new Error(
      `Could not read the device after ${CONFIGURE_MAX_ATTEMPTS} attempts (${lastErr?.message ?? lastErr}). ` +
      "Check the device is powered on and the USB cable carries data (not power-only), and that no other " +
      "program (a serial monitor, the Meshtastic CLI, etc.) already has the port open.",
    );
  }
  throw new Error(
    `Could not read the device after ${CONFIGURE_MAX_ATTEMPTS} attempts (${lastErr?.message ?? lastErr}). ` +
    "If this was the first time connecting to this device, check whether your OS is showing a Bluetooth " +
    "pairing/PIN dialog that needs a tap to accept, then try again -- once a device is bonded, reconnecting is " +
    "much faster. Otherwise, check the device is awake and in range, and that it's already paired at the OS " +
    "level (Windows/Android Bluetooth settings) -- some nRF52-based devices need that before Web Bluetooth GATT " +
    "works reliably.",
  );
}

async function handleConnectNewVia(connectFn) {
  state.ui.busy = true;
  state.ui.busyMessage = "Waiting for device selection…";
  state.connectionStatus = "connecting";
  renderApp();

  const initial = await connectFn(); // requestDevice()/requestPort() picker: must run from this click's user gesture
  state.liveSnapshot = null;

  const { connection, snap } = await captureWithRetry(initial, { freshConnection: initial });
  state.connection = connection;
  state.liveSnapshot = snap;
  state.connectionStatus = "connected";

  const bound = listLocalProfiles(state.store).find((p) => p.boundTo?.nodeNum === snap.nodeNum);
  if (bound) {
    bound.boundTo = { nodeNum: snap.nodeNum, bleName: connectionLabel(connection), hwModel: snap.hwModel ?? null };
    upsertLocalProfile(state.store, bound);
  }
}

function handleConnectNewBle() {
  return handleConnectNewVia(connectNew);
}

function handleConnectNewSerial() {
  return handleConnectNewVia(connectNewSerial);
}

async function handleDisconnect() {
  state.ui.busy = true; // keeps watchConnection() quiet -- this is the expected disconnect
  renderApp();
  await bleDisconnect(state.connection);
  watchConnection(null);
  state.connection = null;
  state.liveSnapshot = null;
  state.connectionStatus = "disconnected";
  state.ui.writePlan = null;
  state.ui.writeVerify = null;
}

async function handleFactoryReset() {
  if (!state.connection) throw new Error("Not connected");
  state.ui.busy = true;
  state.ui.busyMessage = "Factory resetting device…";
  renderApp();

  // Firmware disables Bluetooth and reboots immediately after this admin
  // call (confirmed against AdminModule.cpp: both factory-reset variants
  // call disableBluetooth() then reboot()) -- the connection is gone the
  // moment this resolves, whether or not the device had time to send a
  // reply first. Treat it the same as a manual disconnect rather than
  // trying to reconnect: there's nothing meaningful to read back from a
  // device that just erased itself.
  try {
    await state.connection.device.factoryResetDevice();
  } finally {
    await bleDisconnect(state.connection);
    watchConnection(null);
    state.connection = null;
    state.liveSnapshot = null;
    state.connectionStatus = "disconnected";
    state.ui.writePlan = null;
    state.ui.writeVerify = null;
    // Erasing "node data entirely" (see the Write tab's confirm text) wipes
    // the nRF52's own Bluetooth bonding keys along with everything else --
    // but the OS's side of that bond is untouched, so the two are now
    // mismatched. The device won't respond to the stale bond, and the OS
    // won't automatically renegotiate a new one; it just fails to
    // reconnect until the device is removed/forgotten from the OS's
    // Bluetooth settings and re-paired from scratch. Nothing in Web
    // Bluetooth's API lets a page do that removal itself (deliberately --
    // it would let any site silently drop a user's unrelated pairings), so
    // this can only be surfaced as guidance, not automated away.
    state.ui.notice = "Factory reset complete. If reconnecting fails, this device's Bluetooth pairing " +
      "is likely stale (the firmware wiped its own bonding info, but your OS didn't) -- remove/forget it in " +
      "your OS's Bluetooth settings, then reconnect to re-pair from scratch. On Windows, " +
      "tools/windows-unpair-bluetooth.ps1 in this repo does that from the command line.";
  }
}

async function handleEnterDfuMode() {
  if (!state.connection) throw new Error("Not connected");
  state.ui.busy = true;
  state.ui.busyMessage = "Entering DFU mode…";
  renderApp();

  // enterDfuMode() reboots straight into the nRF52 bootloader, which
  // advertises as an entirely different BLE peripheral (Nordic DFU
  // service, not Meshtastic's) -- there's nothing to reconnect to as a
  // MeshDevice afterward, so this is treated the same as a manual
  // disconnect, same as factory reset. Unlike factory reset, nothing on
  // the device is erased, so there's no stale-OS-pairing concern here:
  // the bootloader isn't the same advertised device the OS bonded with.
  try {
    await state.connection.device.enterDfuMode();
  } finally {
    await bleDisconnect(state.connection);
    watchConnection(null);
    state.connection = null;
    state.liveSnapshot = null;
    state.connectionStatus = "disconnected";
    state.ui.writePlan = null;
    state.ui.writeVerify = null;
    state.ui.notice = "Device is now in DFU (bootloader) mode and disconnected from MeshFleet. " +
      "It won't act as a normal Meshtastic node again until you flash new firmware over it, or " +
      "reset/power-cycle it back to normal operation.";
  }
}

async function handleRecapture() {
  if (!state.connection) throw new Error("Not connected");
  state.ui.busy = true;
  renderApp();
  const { connection, snap } = await captureWithRetry(state.connection, { freshConnection: state.connection });
  state.connection = connection;
  state.liveSnapshot = snap;
  state.connectionStatus = "connected";
}

async function handleGenerateKeypair(localProfileId) {
  const profile = state.store.localProfiles[localProfileId];
  if (!profile) return;
  const b64 = await generatePrivateKeyBase64();
  profile.security.privateKey = b64;
  touch(profile);
  upsertLocalProfile(state.store, profile);
}

async function handleExecuteWrite() {
  const plan = state.ui.writePlan;
  if (!plan || plan.isEmpty || !state.connection) return;

  state.ui.busy = true;
  state.ui.writeLog = [];
  state.ui.writeVerify = null;
  renderApp();

  const log = (msg) => {
    state.ui.writeLog = [...state.ui.writeLog, msg];
    renderApp();
  };

  await executeWritePlan(state.connection.device, plan, { onLog: log });
  log("Write committed — device is saving and rebooting.");

  const rebootWaitMs = state.store.settings.rebootWaitMs ?? 8000;
  state.connectionStatus = "reconnecting";
  state.ui.busyMessage = `Waiting ${Math.round(rebootWaitMs / 1000)}s for reboot…`;
  renderApp();
  await new Promise((resolve) => setTimeout(resolve, rebootWaitMs));

  log("Reconnecting…");
  const connRef = state.connection;
  const { connection: newConnection, snap: postSnap } = await captureWithRetry(connRef);
  state.connection = newConnection;
  state.liveSnapshot = postSnap;
  state.connectionStatus = "connected";
  log("Reconnected and verified read. Checking results…");
  state.ui.writeVerify = verifyWritePlan(plan, postSnap);
  const okCount = state.ui.writeVerify.filter((r) => r.ok).length;
  log(`Verification complete: ${okCount}/${state.ui.writeVerify.length} fields match.`);

  const bound = listLocalProfiles(state.store).find((p) => p.boundTo?.nodeNum === postSnap.nodeNum);
  if (bound) {
    const label = connectionLabel(newConnection);
    state.store.snapshots[bound.id] = { ...postSnap, label: label ?? bound.label };
    bound.boundTo = { nodeNum: postSnap.nodeNum, bleName: label, hwModel: postSnap.hwModel ?? null };
    upsertLocalProfile(state.store, bound);
  }
}

renderApp();
