// localStorage persistence for the whole app: global profiles, local
// (per-device) profiles, last-read snapshots, and small app settings.
// Everything is plain JSON -- config values inside profiles/snapshots are
// stored as protobuf JSON (see schema.js / snapshot.js), which round-trips
// exactly through @bufbuild/protobuf's toJson()/fromJson().

const STORAGE_KEY = "meshfleet.v1";

export function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyStore() {
  return {
    version: 1,
    globalProfiles: {},
    localProfiles: {},
    snapshots: {},
    settings: {
      lastGlobalProfileId: null,
      lastLocalProfileId: null,
      rebootWaitMs: 8000,
    },
  };
}

export function load() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.error("localStorage unavailable, running with an in-memory store", err);
    return emptyStore();
  }
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      console.warn("Stored MeshFleet data has an unexpected shape; starting fresh.");
      return emptyStore();
    }
    const base = emptyStore();
    return {
      ...base,
      ...parsed,
      globalProfiles: parsed.globalProfiles || {},
      localProfiles: parsed.localProfiles || {},
      snapshots: parsed.snapshots || {},
      settings: { ...base.settings, ...(parsed.settings || {}) },
    };
  } catch (err) {
    console.error("Failed to parse stored MeshFleet data, starting fresh", err);
    return emptyStore();
  }
}

export function save(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.error("Failed to save MeshFleet store", err);
    throw err;
  }
}

export function exportJson(store) {
  return JSON.stringify(store, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
    throw new Error('Not a MeshFleet export: expected an object with "version": 1');
  }
  const base = emptyStore();
  return {
    ...base,
    ...parsed,
    globalProfiles: parsed.globalProfiles || {},
    localProfiles: parsed.localProfiles || {},
    snapshots: parsed.snapshots || {},
    settings: { ...base.settings, ...(parsed.settings || {}) },
  };
}
