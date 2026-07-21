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
import * as globalEditor from "./ui/globalEditor.js";
import * as localEditor from "./ui/localEditor.js";
import * as readView from "./ui/readView.js";
import * as writeView from "./ui/writeView.js";
import * as dataView from "./ui/dataView.js";
import { connectNew, reconnect, disconnect as bleDisconnect } from "./conn.js";
import { captureSnapshot } from "./snapshot.js";
import { executeWritePlan, verifyWritePlan } from "./writer.js";
import { generatePrivateKeyBase64 } from "./keys.js";
import { listLocalProfiles, upsertLocalProfile, touch } from "./profiles.js";

const routeModules = {
  fleet: fleetView,
  global: globalEditor,
  local: localEditor,
  read: readView,
  write: writeView,
  data: dataView,
};

const state = {
  store: storage.load(),
  route: "fleet",
  connection: null, // { bleDevice, transport, device } | null
  connectionStatus: "disconnected", // disconnected|connecting|configuring|connected|reconnecting
  liveSnapshot: null,
  ui: {
    error: null,
    busy: false,
    busyMessage: "",
    selectedGlobalId: null,
    selectedLocalId: null,
    globalEditorSection: "channels",
    advancedExpanded: new Set(),
    revealedSecrets: new Set(),
    readMode: "global",
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
  let result = shell.onAction(state, action, target, event);
  if (result === false) result = view.onAction(state, action, target, event);

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
        await withTerminalConnectionStatus(handleConnectNew);
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
// prompt) a few times papers over that instead of surfacing a dead end.
const CONFIGURE_MAX_ATTEMPTS = 4;
const CONFIGURE_RETRY_DELAY_MS = 1500;

async function captureWithRetry(bleDevice, { freshConnection } = {}) {
  let connection = freshConnection ?? null;
  let lastErr;
  for (let attempt = 1; attempt <= CONFIGURE_MAX_ATTEMPTS; attempt++) {
    try {
      if (!connection) {
        state.ui.busyMessage = attempt === 1
          ? "Connecting…"
          : `Reconnecting (attempt ${attempt}/${CONFIGURE_MAX_ATTEMPTS})…`;
        state.connectionStatus = "connecting";
        renderApp();
        connection = await reconnect(bleDevice, { retries: 3, delayMs: 1000 });
      }
      state.connection = connection;
      state.connectionStatus = "configuring";
      state.ui.busyMessage = "Reading device configuration…";
      renderApp();
      const snap = await captureSnapshot(connection.device, { onProgress: onSnapshotProgress, timeoutMs: 20000 });
      return { connection, snap };
    } catch (err) {
      lastErr = err;
      console.warn(`Connect/configure attempt ${attempt}/${CONFIGURE_MAX_ATTEMPTS} failed`, err);
      connection = null; // discard the broken transport; force a fresh GATT connect next attempt
      if (attempt < CONFIGURE_MAX_ATTEMPTS) {
        state.ui.busyMessage = `Connection dropped, retrying (${attempt}/${CONFIGURE_MAX_ATTEMPTS})…`;
        renderApp();
        await new Promise((resolve) => setTimeout(resolve, CONFIGURE_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(
    `Could not read the device after ${CONFIGURE_MAX_ATTEMPTS} attempts (${lastErr?.message ?? lastErr}). ` +
    "If this keeps happening, check the device is awake and in range, and that it's already paired at the OS " +
    "level (Windows Bluetooth settings) -- some nRF52-based devices need that before Web Bluetooth GATT works reliably.",
  );
}

async function handleConnectNew() {
  state.ui.busy = true;
  state.ui.busyMessage = "Waiting for device selection…";
  state.connectionStatus = "connecting";
  renderApp();

  const initial = await connectNew(); // requestDevice() picker: must run from this click's user gesture
  state.liveSnapshot = null;

  const { connection, snap } = await captureWithRetry(initial.bleDevice, { freshConnection: initial });
  state.connection = connection;
  state.liveSnapshot = snap;
  state.connectionStatus = "connected";

  const bound = listLocalProfiles(state.store).find((p) => p.boundTo?.nodeNum === snap.nodeNum);
  if (bound) {
    bound.boundTo = { nodeNum: snap.nodeNum, bleName: connection.bleDevice?.name ?? null, hwModel: snap.hwModel ?? null };
    upsertLocalProfile(state.store, bound);
  }
}

async function handleDisconnect() {
  await bleDisconnect(state.connection);
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
    state.connection = null;
    state.liveSnapshot = null;
    state.connectionStatus = "disconnected";
    state.ui.writePlan = null;
    state.ui.writeVerify = null;
  }
}

async function handleRecapture() {
  if (!state.connection) throw new Error("Not connected");
  state.ui.busy = true;
  renderApp();
  const { connection, snap } = await captureWithRetry(state.connection.bleDevice, { freshConnection: state.connection });
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
  const bleDeviceRef = state.connection.bleDevice;
  const { connection: newConnection, snap: postSnap } = await captureWithRetry(bleDeviceRef);
  state.connection = newConnection;
  state.liveSnapshot = postSnap;
  state.connectionStatus = "connected";
  log("Reconnected and verified read. Checking results…");
  state.ui.writeVerify = verifyWritePlan(plan, postSnap);
  const okCount = state.ui.writeVerify.filter((r) => r.ok).length;
  log(`Verification complete: ${okCount}/${state.ui.writeVerify.length} fields match.`);

  const bound = listLocalProfiles(state.store).find((p) => p.boundTo?.nodeNum === postSnap.nodeNum);
  if (bound) {
    state.store.snapshots[bound.id] = { ...postSnap, label: newConnection.bleDevice?.name ?? bound.label };
    bound.boundTo = { nodeNum: postSnap.nodeNum, bleName: newConnection.bleDevice?.name ?? null, hwModel: postSnap.hwModel ?? null };
    upsertLocalProfile(state.store, bound);
  }
}

renderApp();
