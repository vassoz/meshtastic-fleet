// CRUD + "which fields are managed" bookkeeping for global (fleet-wide)
// and local (per-device) profiles.
//
// A global profile is sparse *by field*, not by section: it carries a flat
// list of fully-qualified leaf paths it manages (e.g.
// "config.position.gpsUpdateInterval", "channels.0.settings.name",
// "moduleConfig.neighborInfo.updateInterval") plus a `data` tree holding
// the value at each of those paths. Everything NOT listed in
// `managedPaths` is left untouched on the device -- see writer.js for why
// that distinction matters (the firmware replaces a whole config section
// on write, so "untouched" has to be enforced by read-modify-write, not
// by omission alone).
import { uid } from "./storage.js";
import { getPath, setPath, deletePath, deepClone } from "./util.js";

export function newGlobalProfile(name = "New global profile") {
  return {
    id: uid(),
    name,
    notes: "",
    updatedAt: new Date().toISOString(),
    managedPaths: [],
    data: { config: {}, moduleConfig: {}, channels: {} },
  };
}

export function newLocalProfile(label = "New device") {
  return {
    id: uid(),
    label,
    updatedAt: new Date().toISOString(),
    owner: { longName: "", shortName: "", isLicensed: false },
    security: { privateKey: "", publicKey: "" },
    fixedPosition: null, // { latitudeI, longitudeI, altitude? } | null -- latitudeI/longitudeI are degrees * 1e7 (wire format)
    clearFixedPosition: false, // if true and fixedPosition is null, an active write clears any fixed position on the device
    bluetooth: null, // { fixedPin: number } | null
    boundTo: null, // { nodeNum, bleName, hwModel } | null -- last device this was applied to
  };
}

export function listGlobalProfiles(store) {
  return Object.values(store.globalProfiles).sort((a, b) => a.name.localeCompare(b.name));
}

export function listLocalProfiles(store) {
  return Object.values(store.localProfiles).sort((a, b) => a.label.localeCompare(b.label));
}

export function upsertGlobalProfile(store, profile) {
  store.globalProfiles[profile.id] = profile;
}

export function upsertLocalProfile(store, profile) {
  store.localProfiles[profile.id] = profile;
}

export function deleteGlobalProfile(store, id) {
  delete store.globalProfiles[id];
}

export function deleteLocalProfile(store, id) {
  delete store.localProfiles[id];
}

export function touch(profile) {
  profile.updatedAt = new Date().toISOString();
  return profile;
}

export function isManaged(profile, fullPath) {
  return profile.managedPaths.includes(fullPath);
}

export function setManagedField(profile, fullPath, value) {
  if (!profile.managedPaths.includes(fullPath)) profile.managedPaths.push(fullPath);
  setPath(profile.data, fullPath, deepClone(value));
  touch(profile);
}

export function unsetManagedField(profile, fullPath) {
  profile.managedPaths = profile.managedPaths.filter((p) => p !== fullPath);
  deletePath(profile.data, fullPath);
  touch(profile);
}

export function managedValue(profile, fullPath) {
  return getPath(profile.data, fullPath);
}

/** Promote selected diff rows (see diff.js: {area, sectionKey, fieldPath,
 * otherValue}) into a global profile, marking each one managed with the
 * value observed on the device. */
export function promoteRows(profile, rows) {
  for (const row of rows) {
    setManagedField(profile, `${row.area}.${row.sectionKey}.${row.fieldPath}`, row.otherValue);
  }
}

/** Group a profile's managedPaths by (area, sectionKey) -> [fieldPath, ...],
 * the shape writer.js needs to know which sections to touch and which
 * leaves within them to overlay. */
export function managedBySection(profile) {
  const out = {}; // "config.position" -> ["gpsUpdateInterval", ...]
  for (const full of profile.managedPaths) {
    const [area, sectionKey, ...rest] = full.split(".");
    if (rest.length === 0) continue;
    const key = `${area}.${sectionKey}`;
    (out[key] ??= []).push(rest.join("."));
  }
  return out;
}
