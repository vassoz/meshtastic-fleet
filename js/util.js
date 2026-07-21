// Small dependency-free helpers shared across the app.

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function getPath(obj, path) {
  const parts = Array.isArray(path) ? path : path.split(".");
  let cur = obj;
  for (const key of parts) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Set obj.a.b.c = value, creating intermediate plain objects as needed.
 * Mutates and returns obj. */
export function setPath(obj, path, value) {
  const parts = Array.isArray(path) ? path : path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

export function deletePath(obj, path) {
  const parts = Array.isArray(path) ? path : path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (!isPlainObject(cur)) return obj;
  }
  delete cur[parts[parts.length - 1]];
  return obj;
}

/** Deep-clone a JSON-shaped value (no functions/undefined/dates/etc). */
export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Overlay `overrides` (sparse) onto `base` (a full section JSON), only at
 * the leaf paths listed in `paths`. Returns a new object; does not mutate
 * `base`. This is the read-modify-write step required because the
 * firmware replaces an entire Config/ModuleConfig/Channel section
 * wholesale on write (see AdminModule.cpp: `config.position = ...`),
 * never merging field-by-field. */
export function overlayPaths(base, overrides, paths) {
  const result = deepClone(base) ?? {};
  for (const path of paths) {
    setPath(result, path, deepClone(getPath(overrides, path)));
  }
  return result;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBase64(byteLength) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * Recursively drop keys whose value is `undefined`. A profile can end up
 * with a managed leaf whose stored value is `undefined` if it was
 * promoted from a Read diff row where the device's side was absent --
 * which happens legitimately whenever a field sits at its protobuf zero
 * value (proto3 JSON omits implicit-presence fields that are 0/false/"",
 * so a bool that's currently `false` on the reference device shows up as
 * "not present" rather than as the literal value `false`). JSON itself
 * has no way to represent `undefined`, and @bufbuild/protobuf's
 * fromJson() throws on an explicit `undefined` rather than treating it
 * the same as an absent key -- so this normalizes it back to "absent",
 * which fromJson correctly resolves to the field's real zero value.
 * Returns a new value; does not mutate.
 */
export function stripUndefinedDeep(value) {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[key] = stripUndefinedDeep(v);
    }
    return out;
  }
  return value;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export function formatTimestamp(iso) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
