// App chrome: tab nav + connection indicator, and the handful of actions
// that aren't specific to one tab (navigate, connect, disconnect, export,
// import). Each tab's own view module (fleet/localEditor/readView/
// writeView) renders its own content and handles its own data-action
// names; shell.js's onAction() is tried first by main.js's central
// dispatcher, and returns false to let the active view's handler take
// over.
//
// There's no manual "author a global profile by hand" tab: global
// profiles are built exclusively by reading a reference device (Read tab)
// and promoting the specific fields you want to keep -- see readView.js.
import { escapeHtml, formatTimestamp } from "../util.js";
import { bluetoothAvailable, serialAvailable, connectionLabel } from "../conn.js";

const TABS = [
  { route: "fleet", label: "Fleet" },
  { route: "local", label: "Local" },
  { route: "read", label: "Read" },
  { route: "write", label: "Write" },
  { route: "data", label: "Data" },
];

export function renderHeader(state) {
  const tabs = TABS.map((t) => `<button type="button" class="tab${state.route === t.route ? " active" : ""}"
    data-action="nav" data-route="${t.route}">${t.label}</button>`).join("");

  const conn = renderConnectionIndicator(state);

  return `<header class="app-header">
    <div class="brand">MeshFleet</div>
    <nav class="tabs">${tabs}</nav>
    <div class="conn-indicator">${conn}</div>
  </header>
  ${state.ui.error ? `<div class="banner error">${escapeHtml(state.ui.error)} <button type="button" data-action="dismiss-error">×</button></div>` : ""}
  ${state.ui.notice ? `<div class="banner warn">${escapeHtml(state.ui.notice)} <button type="button" data-action="dismiss-notice">×</button></div>` : ""}
  ${!bluetoothAvailable() && !serialAvailable() ? `<div class="banner warn">Neither Web Bluetooth nor Web Serial is available in this browser. ` +
    `Use Chrome or Edge -- desktop for USB, desktop or Android for Bluetooth.</div>` : ""}`;
}

function renderConnectionIndicator(state) {
  const status = state.connectionStatus;
  if (status === "connected") {
    const name = connectionLabel(state.connection, state.liveSnapshot) ?? "device";
    const node = state.liveSnapshot?.nodeNum != null ? ` #${state.liveSnapshot.nodeNum}` : "";
    return `<span class="dot ok"></span> Connected: ${escapeHtml(name)}${node}
      <button type="button" data-action="disconnect">Disconnect</button>`;
  }
  if (status === "connecting" || status === "configuring" || status === "reconnecting") {
    // Reconnecting after a factory reset/write can legitimately fail (the
    // device may have re-enumerated as a different USB port, or the old
    // Bluetooth pairing may be stale -- see tools/windows-unpair-bluetooth.ps1)
    // and the retry budget can take minutes to exhaust on its own. Cancel
    // gives up on it immediately and drops back to "Not connected" so a
    // fresh Connect (with its own device/port picker) is one click away,
    // instead of waiting it out or reloading the page.
    return `<span class="dot busy"></span> ${escapeHtml(state.ui.busyMessage || status)}…
      <button type="button" data-action="cancel-connect">Cancel</button>`;
  }
  return `<span class="dot off"></span> Not connected
    ${bluetoothAvailable() ? `<button type="button" data-action="connect-new">Connect via Bluetooth…</button>` : ""}
    ${serialAvailable() ? `<button type="button" data-action="connect-new-serial">Connect via USB…</button>` : ""}`;
}

export function onAction(state, action, target) {
  switch (action) {
    case "nav":
      state.route = target.dataset.route;
      if (target.dataset.selectLocal) state.ui.selectedLocalId = target.dataset.selectLocal;
      return true;
    case "dismiss-error":
      state.ui.error = null;
      return true;
    case "dismiss-notice":
      state.ui.notice = null;
      return true;
    case "connect-new":
      return { asyncAction: "connect-new" };
    case "connect-new-serial":
      return { asyncAction: "connect-new-serial" };
    case "disconnect":
      return { asyncAction: "disconnect" };
    case "cancel-connect":
      // Synchronous, not an asyncAction: bumping actionToken is all that's
      // needed to make the stuck captureWithRetry() loop notice and bail
      // out on its own (main.js) -- no need to await it here.
      state.ui.actionToken = (state.ui.actionToken ?? 0) + 1;
      state.connection = null;
      state.liveSnapshot = null;
      state.connectionStatus = "disconnected";
      state.ui.busy = false;
      state.ui.busyMessage = "";
      state.ui.writePlan = null;
      state.ui.writeVerify = null;
      return true;
    default:
      return false;
  }
}

export { formatTimestamp };
