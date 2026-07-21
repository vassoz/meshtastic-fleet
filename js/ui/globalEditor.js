// Global tab: fleet-wide profile editor. Channels/Position/LoRa/Device/
// Security are curated forms over specific fields; Advanced is the same
// renderer walking every remaining Config/ModuleConfig section from the
// live protobuf schema, so nothing is unreachable and firmware bumps that
// add fields just show up.
import {
  getConfigSectionSchema,
  getModuleConfigSectionSchema,
  getConfigSections,
  getModuleConfigSections,
  ChannelSchema,
  ChannelSettingsSchema,
  ModuleSettingsSchema,
} from "../schema.js";
import {
  listGlobalProfiles,
  newGlobalProfile,
  upsertGlobalProfile,
  deleteGlobalProfile,
  isManaged,
  setManagedField,
  unsetManagedField,
  managedValue,
  touch,
} from "../profiles.js";
import { renderSectionFields, parseFieldInput } from "./fields.js";
import { classifyField } from "../schema.js";
import { escapeHtml, formatTimestamp, randomBase64 } from "../util.js";

// From meshtastic/protobufs config.proto: Config.PositionConfig.PositionFlags.
// A stable bitfield (part of the wire format), not something that grows
// with ordinary firmware feature work -- safe to hardcode.
const POSITION_FLAG_BITS = [
  ["ALTITUDE", 0x0001],
  ["ALTITUDE_MSL", 0x0002],
  ["GEOIDAL_SEPARATION", 0x0004],
  ["DOP", 0x0008],
  ["HVDOP", 0x0010],
  ["SATINVIEW", 0x0020],
  ["SEQ_NO", 0x0040],
  ["TIMESTAMP", 0x0080],
  ["HEADING", 0x0100],
  ["SPEED", 0x0200],
];

const CURATED_SECTIONS = [
  { key: "channels", label: "Channels" },
  { key: "position", label: "Position / GPS" },
  { key: "lora", label: "LoRa" },
  { key: "device", label: "Device" },
  { key: "security", label: "Security" },
  { key: "advanced", label: "Advanced" },
];

export function render(state) {
  const list = listGlobalProfiles(state.store);
  if (!state.ui.selectedGlobalId || !state.store.globalProfiles[state.ui.selectedGlobalId]) {
    state.ui.selectedGlobalId = list[0]?.id ?? null;
  }
  const profile = state.ui.selectedGlobalId ? state.store.globalProfiles[state.ui.selectedGlobalId] : null;
  const section = state.ui.globalEditorSection || "channels";

  const tabs = list.map((p) => `<button type="button" class="profile-tab${p.id === state.ui.selectedGlobalId ? " active" : ""}"
    data-action="select-global-profile" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join("");

  return `<section class="view global-view">
    <div class="view-header">
      <h2>Global (fleet) profiles</h2>
      <button type="button" data-action="new-global-profile">+ New</button>
    </div>
    <div class="profile-tabs">${tabs}</div>
    ${profile ? renderProfile(state, profile, section) : `<p class="muted">No global profiles yet.</p>`}
  </section>`;
}

function renderProfile(state, profile, section) {
  const sectionNav = CURATED_SECTIONS.map((s) => `<button type="button" class="section-tab${s.key === section ? " active" : ""}"
    data-action="select-global-section" data-key="${s.key}">${s.label}</button>`).join("");

  return `<div class="profile-detail" data-id="${profile.id}">
    <label class="row">Name <input type="text" data-action="global-meta" data-field="name" value="${escapeHtml(profile.name)}" /></label>
    <label class="row">Notes <input type="text" data-action="global-meta" data-field="notes" value="${escapeHtml(profile.notes)}" placeholder="optional" /></label>
    <p class="muted">Updated ${formatTimestamp(profile.updatedAt)} · managing ${profile.managedPaths.length} field(s)</p>
    <div class="section-tabs">${sectionNav}</div>
    ${renderSection(state, profile, section)}
    <div class="row-actions danger-zone">
      <button type="button" class="danger" data-action="delete-global-profile" data-id="${profile.id}">Delete this profile</button>
    </div>
  </div>`;
}

function renderSection(state, profile, section) {
  if (section === "channels") return renderChannels(profile);
  if (section === "position") return renderPosition(profile);
  if (section === "lora") {
    return renderSectionFields(getConfigSectionSchema("lora"), "config.lora", profile, {
      only: ["region", "usePreset", "modemPreset", "hopLimit", "txEnabled", "txPower", "overrideDutyCycle", "ignoreMqtt", "configOkToMqtt"],
    });
  }
  if (section === "device") {
    return renderSectionFields(getConfigSectionSchema("device"), "config.device", profile, {
      only: ["role", "rebroadcastMode", "nodeInfoBroadcastSecs", "buttonGpio", "tzdef"],
    });
  }
  if (section === "security") {
    return renderSectionFields(getConfigSectionSchema("security"), "config.security", profile, {
      only: ["adminKey", "isManaged", "serialEnabled", "debugLogApiEnabled", "adminChannelEnabled"],
    });
  }
  if (section === "advanced") return renderAdvanced(state, profile);
  return "";
}

function renderChannels(profile) {
  const cards = [];
  for (let idx = 0; idx < 8; idx++) {
    const base = `channels.${idx}`;
    const roleField = renderSectionFields(ChannelSchema, base, profile, { only: ["role"] });
    const settingsFields = renderSectionFields(ChannelSettingsSchema, `${base}.settings`, profile, {
      only: ["name", "psk", "uplinkEnabled", "downlinkEnabled"],
    });
    const moduleFields = renderSectionFields(ModuleSettingsSchema, `${base}.settings.moduleSettings`, profile, {
      only: ["positionPrecision", "isClientMuted"],
    });
    const pskManaged = isManaged(profile, `${base}.settings.psk`);
    cards.push(`<fieldset class="channel-card">
      <legend>Channel ${idx}${idx === 0 ? " (primary)" : ""}</legend>
      ${roleField}
      ${settingsFields}
      ${pskManaged ? `<div class="row-actions psk-actions">
        <button type="button" data-action="psk-quick" data-idx="${idx}" data-mode="random32">Random AES256 key</button>
        <button type="button" data-action="psk-quick" data-idx="${idx}" data-mode="random16">Random AES128 key</button>
        <button type="button" data-action="psk-quick" data-idx="${idx}" data-mode="none">No encryption</button>
      </div>` : ""}
      <p class="muted">Position precision is bits of location shared (0 = none, 32 = exact); each extra bit roughly halves the shared area.</p>
      ${moduleFields}
    </fieldset>`);
  }
  return `<div class="channel-grid">${cards.join("")}</div>`;
}

function renderPosition(profile) {
  const schema = getConfigSectionSchema("position");
  const regular = renderSectionFields(schema, "config.position", profile, {
    only: ["gpsMode", "positionBroadcastSecs", "positionBroadcastSmartEnabled", "broadcastSmartMinimumIntervalSecs", "broadcastSmartMinimumDistance", "gpsUpdateInterval"],
  });
  return regular + renderPositionFlags(profile);
}

function renderPositionFlags(profile) {
  const path = "config.position.positionFlags";
  const managed = isManaged(profile, path);
  const current = managed ? (managedValue(profile, path) ?? 0) : 0;
  const boxes = POSITION_FLAG_BITS.map(([name, bit]) => `
    <label class="flag-bit"><input type="checkbox" data-action="toggle-position-flag-bit" data-bit="${bit}"
      ${(current & bit) ? "checked" : ""} ${managed ? "" : "disabled"} /> ${name}</label>`).join("");
  return `<div class="field-row flags-row">
    <label class="field-manage">
      <input type="checkbox" data-action="toggle-managed" data-path="${path}" ${managed ? "checked" : ""} />
      <span class="field-label">Position flags (what to include in position reports)</span>
    </label>
    <div class="flag-bits">${boxes}</div>
  </div>`;
}

function renderAdvanced(state, profile) {
  const configBlocks = getConfigSections()
    .filter((s) => !["device", "position", "lora", "security"].includes(s.key)) // already curated
    .map((s) => renderAdvancedSection(state, profile, "config", s));
  const moduleBlocks = getModuleConfigSections().map((s) => renderAdvancedSection(state, profile, "moduleConfig", s));
  return `<div class="advanced-tree">
    <p class="muted">Everything not covered by the curated tabs above, generated directly from the device's protobuf schema.</p>
    <h3>Config</h3>
    ${configBlocks.join("")}
    <h3>Module config</h3>
    ${moduleBlocks.join("")}
  </div>`;
}

function renderAdvancedSection(state, profile, area, section) {
  const key = `${area}.${section.key}`;
  const expanded = state.ui.advancedExpanded.has(`${profile.id}:${key}`);
  return `<div class="advanced-section${expanded ? " expanded" : ""}">
    <button type="button" class="advanced-summary" data-action="advanced-toggle" data-key="${key}">
      <span class="disclosure">${expanded ? "▾" : "▸"}</span> ${escapeHtml(section.label)}
    </button>
    ${expanded ? `<div class="advanced-body">${renderSectionFields(section.schema, key, profile)}</div>` : ""}
  </div>`;
}

export function onAction(state, action, target) {
  const profile = state.ui.selectedGlobalId ? state.store.globalProfiles[state.ui.selectedGlobalId] : null;

  switch (action) {
    case "select-global-profile":
      state.ui.selectedGlobalId = target.dataset.id;
      return true;
    case "select-global-section":
      state.ui.globalEditorSection = target.dataset.key;
      return true;
    case "new-global-profile": {
      const p = newGlobalProfile(`Profile ${listGlobalProfiles(state.store).length + 1}`);
      upsertGlobalProfile(state.store, p);
      state.ui.selectedGlobalId = p.id;
      return true;
    }
    case "delete-global-profile": {
      if (!confirm("Delete this global profile? This cannot be undone.")) return true;
      deleteGlobalProfile(state.store, target.dataset.id);
      state.ui.selectedGlobalId = null;
      return true;
    }
    case "global-meta": {
      if (!profile) return true;
      if (target.dataset.field === "name") profile.name = target.value || profile.name;
      if (target.dataset.field === "notes") profile.notes = target.value;
      touch(profile);
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "toggle-managed": {
      if (!profile) return true;
      const path = target.dataset.path;
      if (target.checked) setManagedField(profile, path, defaultValueForPath(path));
      else unsetManagedField(profile, path);
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "set-managed-value": {
      if (!profile) return true;
      const path = target.dataset.path;
      const classified = { kind: target.dataset.kind, repeated: target.dataset.repeated === "1" };
      const raw = target.type === "checkbox" ? target.checked : target.value;
      setManagedField(profile, path, parseFieldInput(classified, raw));
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "set-managed-json": {
      if (!profile) return true;
      const path = target.dataset.path;
      try {
        setManagedField(profile, path, JSON.parse(target.value));
      } catch {
        state.ui.error = "Invalid JSON in advanced field editor";
      }
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "toggle-position-flag-bit": {
      if (!profile) return true;
      const path = "config.position.positionFlags";
      const bit = Number(target.dataset.bit);
      const current = managedValue(profile, path) ?? 0;
      setManagedField(profile, path, target.checked ? (current | bit) : (current & ~bit));
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "psk-quick": {
      if (!profile) return true;
      const idx = target.dataset.idx;
      const path = `channels.${idx}.settings.psk`;
      const mode = target.dataset.mode;
      const value = mode === "none" ? "" : mode === "random16" ? randomBase64(16) : randomBase64(32);
      setManagedField(profile, path, value);
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "advanced-toggle": {
      if (!profile) return true;
      const key = target.dataset.key ?? target.closest("details")?.dataset.key;
      const fullKey = `${profile.id}:${key}`;
      if (state.ui.advancedExpanded.has(fullKey)) state.ui.advancedExpanded.delete(fullKey);
      else state.ui.advancedExpanded.add(fullKey);
      return true;
    }
    default:
      return false;
  }
}

function defaultValueForPath(path) {
  // A reasonable starting value when a field is first checked "managed",
  // based on its classified kind -- refined immediately by the input the
  // checkbox reveals.
  const [area, sectionKey, ...rest] = path.split(".");
  const schema = area === "channels"
    ? (rest[0] === "settings" ? (rest[1] === "moduleSettings" ? ModuleSettingsSchema : ChannelSettingsSchema) : ChannelSchema)
    : area === "config" ? getConfigSectionSchema(sectionKey) : getModuleConfigSectionSchema(sectionKey);
  if (!schema) return "";
  const fieldPath = area === "channels" ? rest.slice(rest[0] === "settings" ? (rest[1] === "moduleSettings" ? 2 : 1) : 0) : rest;
  const field = schema.fields.find((f) => f.localName === fieldPath[fieldPath.length - 1]);
  if (!field) return "";
  const classified = classifyField(field);
  if (classified.repeated) return [];
  if (classified.kind === "bool") return false;
  if (classified.kind === "int" || classified.kind === "float") return 0;
  if (classified.kind === "enum") return classified.enumValues[0]?.name ?? "";
  return "";
}
