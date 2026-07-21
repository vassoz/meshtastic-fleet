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
import { bluetoothAvailable } from "../conn.js";

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
  ${!bluetoothAvailable() ? `<div class="banner warn">Web Bluetooth isn't available in this browser. Use Chrome or Edge on desktop, or Chrome on Android.</div>` : ""}`;
}

function renderConnectionIndicator(state) {
  const status = state.connectionStatus;
  if (status === "connected") {
    const name = state.connection?.bleDevice?.name ?? "device";
    const node = state.liveSnapshot?.nodeNum != null ? ` #${state.liveSnapshot.nodeNum}` : "";
    return `<span class="dot ok"></span> Connected: ${escapeHtml(name)}${node}
      <button type="button" data-action="disconnect">Disconnect</button>`;
  }
  if (status === "connecting" || status === "configuring" || status === "reconnecting") {
    return `<span class="dot busy"></span> ${escapeHtml(state.ui.busyMessage || status)}…`;
  }
  return `<span class="dot off"></span> Not connected
    <button type="button" data-action="connect-new">Connect device…</button>`;
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
    case "connect-new":
      return { asyncAction: "connect-new" };
    case "disconnect":
      return { asyncAction: "disconnect" };
    default:
      return false;
  }
}

export { formatTimestamp };
