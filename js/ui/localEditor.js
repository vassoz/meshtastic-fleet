// Local tab: per-device identity -- long/short name, PKI private key,
// fixed position, BLE fixed PIN. Unlike global profiles, this is a small
// fixed shape (see profiles.js: newLocalProfile()), not schema-driven, so
// it's hand-rendered rather than going through fields.js.
import {
  listLocalProfiles,
  newLocalProfile,
  upsertLocalProfile,
  deleteLocalProfile,
  touch,
} from "../profiles.js";
import { escapeHtml, formatTimestamp } from "../util.js";
import { keyByteLength } from "../keys.js";

const LONG_NAME_MAX = 39; // meshtastic_User.long_name buffer size (firmware-side)
const SHORT_NAME_MAX = 4; // short_name is meant to be a tiny callsign-like tag

export function render(state) {
  const list = listLocalProfiles(state.store);
  if (!state.ui.selectedLocalId || !state.store.localProfiles[state.ui.selectedLocalId]) {
    state.ui.selectedLocalId = list[0]?.id ?? null;
  }
  const profile = state.ui.selectedLocalId ? state.store.localProfiles[state.ui.selectedLocalId] : null;

  const tabs = list.map((p) => `<button type="button" class="profile-tab${p.id === state.ui.selectedLocalId ? " active" : ""}"
    data-action="select-local-profile" data-id="${p.id}">${escapeHtml(p.label)}</button>`).join("");

  return `<section class="view local-view">
    <div class="view-header">
      <h2>Local device profiles</h2>
      <button type="button" data-action="new-local-profile">+ New</button>
    </div>
    <div class="profile-tabs">${tabs}</div>
    ${profile ? renderProfile(state, profile) : `<p class="muted">No local profiles yet.</p>`}
  </section>`;
}

function renderProfile(state, profile) {
  const revealed = state.ui.revealedSecrets.has(`local.${profile.id}.privateKey`);
  const keyLen = profile.security.privateKey ? keyByteLength(profile.security.privateKey) : 0;
  const keyStatus = !profile.security.privateKey
    ? '<span class="muted">not set — device keeps its existing key</span>'
    : keyLen === 32
      ? '<span class="badge ok">32 bytes ✓</span>'
      : `<span class="badge error">${keyLen < 0 ? "invalid base64" : `${keyLen} bytes, expected 32`}</span>`;

  return `<div class="profile-detail" data-id="${profile.id}">
    <label class="row">Label
      <input type="text" data-action="local-field" data-field="label" value="${escapeHtml(profile.label)}" />
    </label>
    <p class="muted">Updated ${formatTimestamp(profile.updatedAt)}
      ${profile.boundTo ? ` · bound to node #${profile.boundTo.nodeNum}` : " · not yet bound to a device"}</p>

    <fieldset>
      <legend>Identity</legend>
      <label class="row">Long name <span class="muted">(max ${LONG_NAME_MAX} chars)</span>
        <input type="text" maxlength="${LONG_NAME_MAX}" data-action="local-field" data-field="owner.longName"
          value="${escapeHtml(profile.owner.longName)}" />
      </label>
      <label class="row">Short name <span class="muted">(max ${SHORT_NAME_MAX} chars)</span>
        <input type="text" maxlength="${SHORT_NAME_MAX}" data-action="local-field" data-field="owner.shortName"
          value="${escapeHtml(profile.owner.shortName)}" />
      </label>
      <label class="row"><input type="checkbox" data-action="local-field" data-field="owner.isLicensed"
        ${profile.owner.isLicensed ? "checked" : ""} /> Licensed (ham) operator</label>
    </fieldset>

    <fieldset>
      <legend>PKI private key</legend>
      <label class="row">Private key (base64) ${keyStatus}
        <span class="secret-field">
          <input type="${revealed ? "text" : "password"}" data-action="local-field" data-field="security.privateKey"
            value="${escapeHtml(profile.security.privateKey)}" placeholder="base64, 32 bytes" autocomplete="off" />
          <button type="button" data-action="toggle-reveal-local" data-key="privateKey" data-id="${profile.id}">${revealed ? "hide" : "reveal"}</button>
        </span>
      </label>
      <div class="row-actions">
        <button type="button" data-action="generate-keypair" data-id="${profile.id}">Generate new key</button>
        <span class="muted">or paste an existing one above (e.g. captured from the device in Read mode)</span>
      </div>
      <p class="muted">The device always recomputes its own public key from whatever private key it's given, so only the
        private key is ever written. Leave blank to keep the device's existing key untouched.</p>
      <label class="row">Public key
        <span class="secret-field">
          <span class="mono">${profile.security.publicKey ? escapeHtml(profile.security.publicKey) : "not captured yet"}</span>
          ${profile.security.publicKey ? `<button type="button" data-action="copy-value" data-value="${escapeHtml(profile.security.publicKey)}">copy</button>` : ""}
        </span>
      </label>
      <p class="muted">Not writable -- the device always derives this from its private key. Captured
        automatically the next time you read this device and save/update its local profile from Read →
        Local identity.</p>
    </fieldset>

    <fieldset>
      <legend>Fixed position <span class="muted">(optional)</span></legend>
      <label class="row"><input type="checkbox" data-action="toggle-fixed-position" data-id="${profile.id}"
        ${profile.fixedPosition ? "checked" : ""} /> Set a fixed position on write</label>
      ${profile.fixedPosition ? `
        <label class="row">Latitude
          <input type="number" step="any" data-action="local-field" data-field="fixedPosition.latitude"
            value="${(profile.fixedPosition.latitudeI * 1e-7).toFixed(7)}" />
        </label>
        <label class="row">Longitude
          <input type="number" step="any" data-action="local-field" data-field="fixedPosition.longitude"
            value="${(profile.fixedPosition.longitudeI * 1e-7).toFixed(7)}" />
        </label>
        <label class="row">Altitude (m, optional)
          <input type="number" step="any" data-action="local-field" data-field="fixedPosition.altitude"
            value="${profile.fixedPosition.altitude ?? ""}" />
        </label>` : `
        <label class="row"><input type="checkbox" data-action="local-field" data-field="clearFixedPosition"
          ${profile.clearFixedPosition ? "checked" : ""} /> Clear any fixed position already on the device</label>`}
    </fieldset>

    <fieldset>
      <legend>Bluetooth fixed PIN <span class="muted">(optional — T1000-E has no screen to show a random PIN)</span></legend>
      <label class="row"><input type="checkbox" data-action="toggle-fixed-pin" data-id="${profile.id}"
        ${profile.bluetooth ? "checked" : ""} /> Use a fixed pairing PIN</label>
      ${profile.bluetooth ? `<label class="row">PIN (6 digits)
        <input type="number" min="0" max="999999" data-action="local-field" data-field="bluetooth.fixedPin"
          value="${profile.bluetooth.fixedPin}" /></label>
        <p class="muted">Also set the global profile's Bluetooth mode to Fixed PIN, or this value won't be used.</p>` : ""}
    </fieldset>

    <fieldset>
      <legend>Ringtone <span class="muted">(RTTTL format, optional)</span></legend>
      <label class="row">Ringtone
        <input type="text" data-action="local-field" data-field="ringtone"
          value="${escapeHtml(profile.ringtone ?? "")}" placeholder="e.g. a:d=8,o=5,b=180:c,e,g" />
      </label>
      <p class="muted">The buzzer melody played on alerts, in RTTTL text format. Captured automatically the
        next time you read this device and save/update its local profile from Read → Local identity, or
        paste/edit one directly. Leave blank to keep the device's existing ringtone untouched.</p>
    </fieldset>

    <div class="row-actions danger-zone">
      <button type="button" class="danger" data-action="delete-local-profile" data-id="${profile.id}">Delete this profile</button>
    </div>
  </div>`;
}

export function onAction(state, action, target) {
  const profile = state.ui.selectedLocalId ? state.store.localProfiles[state.ui.selectedLocalId] : null;

  switch (action) {
    case "select-local-profile":
      state.ui.selectedLocalId = target.dataset.id;
      return true;
    case "new-local-profile": {
      const p = newLocalProfile(`Device ${listLocalProfiles(state.store).length + 1}`);
      upsertLocalProfile(state.store, p);
      state.ui.selectedLocalId = p.id;
      return true;
    }
    case "delete-local-profile": {
      if (!confirm("Delete this local profile? This cannot be undone.")) return true;
      deleteLocalProfile(state.store, target.dataset.id);
      state.ui.selectedLocalId = null;
      return true;
    }
    case "local-field": {
      if (!profile) return true;
      setLocalField(profile, target.dataset.field, target);
      touch(profile);
      upsertLocalProfile(state.store, profile);
      return true;
    }
    case "toggle-reveal-local": {
      const key = `local.${target.dataset.id}.${target.dataset.key}`;
      if (state.ui.revealedSecrets.has(key)) state.ui.revealedSecrets.delete(key);
      else state.ui.revealedSecrets.add(key);
      return true;
    }
    case "copy-value":
      navigator.clipboard?.writeText(target.dataset.value).catch(() => {});
      return true;
    case "toggle-fixed-position": {
      if (!profile) return true;
      profile.fixedPosition = target.checked ? { latitudeI: 0, longitudeI: 0, altitude: null } : null;
      touch(profile);
      upsertLocalProfile(state.store, profile);
      return true;
    }
    case "toggle-fixed-pin": {
      if (!profile) return true;
      profile.bluetooth = target.checked ? { fixedPin: 123456 } : null;
      touch(profile);
      upsertLocalProfile(state.store, profile);
      return true;
    }
    case "generate-keypair":
      return { asyncAction: "generate-keypair", id: target.dataset.id };
    default:
      return false;
  }
}

function setLocalField(profile, field, target) {
  const value = target.type === "checkbox" ? target.checked : target.value;
  switch (field) {
    case "label":
      profile.label = value || profile.label;
      break;
    case "owner.longName":
      profile.owner.longName = value;
      break;
    case "owner.shortName":
      profile.owner.shortName = value;
      break;
    case "owner.isLicensed":
      profile.owner.isLicensed = value;
      break;
    case "security.privateKey":
      profile.security.privateKey = value.trim();
      break;
    case "fixedPosition.latitude":
      profile.fixedPosition ??= { latitudeI: 0, longitudeI: 0, altitude: null };
      profile.fixedPosition.latitudeI = Math.round(Number(value) * 1e7);
      break;
    case "fixedPosition.longitude":
      profile.fixedPosition ??= { latitudeI: 0, longitudeI: 0, altitude: null };
      profile.fixedPosition.longitudeI = Math.round(Number(value) * 1e7);
      break;
    case "fixedPosition.altitude":
      profile.fixedPosition ??= { latitudeI: 0, longitudeI: 0, altitude: null };
      profile.fixedPosition.altitude = value === "" ? null : Math.round(Number(value));
      break;
    case "clearFixedPosition":
      profile.clearFixedPosition = value;
      break;
    case "bluetooth.fixedPin":
      profile.bluetooth ??= { fixedPin: 0 };
      profile.bluetooth.fixedPin = Math.max(0, Math.min(999999, Number(value) || 0));
      break;
    case "ringtone":
      profile.ringtone = value;
      break;
  }
}
