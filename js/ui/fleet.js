// Fleet tab: the local (per-device) profiles as fleet-slot cards, each
// showing what's known about the physical unit it represents (from the
// last time it was read or written) and letting the currently-connected
// device be bound to one.
import { listLocalProfiles, newLocalProfile, upsertLocalProfile } from "../profiles.js";
import { escapeHtml, formatTimestamp } from "../util.js";
import { connectionLabel } from "../conn.js";

export function render(state) {
  const { store } = state;
  const profiles = listLocalProfiles(store);
  const connected = state.connectionStatus === "connected";

  const cards = profiles.map((p) => renderCard(state, p)).join("") ||
    `<p class="muted">No local (per-device) profiles yet. Create one in the Local tab, or connect a device and use Read → Save as local profile.</p>`;

  return `<section class="view fleet-view">
    <div class="view-header">
      <h2>Fleet</h2>
      <button type="button" data-action="new-local-profile-from-fleet">+ Add device slot</button>
    </div>
    ${connected && !state.liveSnapshot ? `<p class="muted">Connected — go to Read to capture this device's config.</p>` : ""}
    <div class="card-grid">${cards}</div>
  </section>`;
}

function renderCard(state, profile) {
  const snapshot = state.store.snapshots[profile.id];
  const isConnectedDevice = state.connectionStatus === "connected" &&
    state.liveSnapshot?.nodeNum != null &&
    profile.boundTo?.nodeNum === state.liveSnapshot.nodeNum;
  const canBind = state.connectionStatus === "connected" && state.liveSnapshot?.nodeNum != null && !isConnectedDevice;

  return `<article class="card fleet-card${isConnectedDevice ? " connected" : ""}">
    <h3>${escapeHtml(profile.label)}</h3>
    <dl>
      <dt>Node</dt><dd>${profile.boundTo ? `#${profile.boundTo.nodeNum} (${escapeHtml(profile.boundTo.hwModel ?? "?")})` : "unbound"}</dd>
      <dt>Connection</dt><dd>${profile.boundTo?.bleName ? escapeHtml(profile.boundTo.bleName) : "—"}</dd>
      <dt>Short name</dt><dd>${escapeHtml(profile.owner.shortName || "—")}</dd>
      <dt>Last read</dt><dd>${formatTimestamp(snapshot?.capturedAt)}</dd>
      <dt>Firmware</dt><dd>${escapeHtml(snapshot?.firmwareVersion || "—")}</dd>
    </dl>
    <div class="card-actions">
      ${isConnectedDevice ? `<span class="badge ok">this is the connected device</span>` : ""}
      ${canBind ? `<button type="button" data-action="bind-connected-device" data-id="${profile.id}">Bind connected device</button>` : ""}
      <button type="button" data-action="nav" data-route="local" data-select-local="${profile.id}">Edit</button>
    </div>
  </article>`;
}

export function onAction(state, action, target) {
  switch (action) {
    case "new-local-profile-from-fleet": {
      const p = newLocalProfile(`Device ${listLocalProfiles(state.store).length + 1}`);
      upsertLocalProfile(state.store, p);
      state.ui.selectedLocalId = p.id;
      state.route = "local";
      return true;
    }
    case "bind-connected-device": {
      const profile = state.store.localProfiles[target.dataset.id];
      if (profile && state.liveSnapshot) {
        profile.boundTo = {
          nodeNum: state.liveSnapshot.nodeNum,
          bleName: connectionLabel(state.connection),
          hwModel: state.liveSnapshot.hwModel ?? null,
        };
        upsertLocalProfile(state.store, profile);
      }
      return true;
    }
    default:
      return false;
  }
}
