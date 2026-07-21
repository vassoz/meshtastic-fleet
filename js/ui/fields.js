// Generic, schema-driven form field rendering for global profile config
// sections. Both the curated sections (Channels/Position/LoRa/...) and the
// auto-generated "Advanced" tree call the same renderSectionFields(): the
// curated ones just pass `only` to restrict which fields show, and give
// the section a friendlier place in the UI. This is what makes new
// firmware fields show up automatically after a vendor.py version bump
// instead of needing hand-written UI for every field.
import { classifyField, isSensitiveField, humanize } from "../schema.js";
import { isManaged, managedValue } from "../profiles.js";
import { escapeHtml } from "../util.js";

/** Convert a raw HTML form value back to the JS value fromJson() expects
 * for a given classified field kind. */
export function parseFieldInput(classified, raw) {
  const { kind, repeated } = classified;
  if (repeated) {
    const items = String(raw ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return items.map((item) => parseScalarLike(kind, item));
  }
  if (kind === "bool") return raw === true || raw === "true" || raw === "on";
  return parseScalarLike(kind, raw);
}

function parseScalarLike(kind, raw) {
  if (kind === "int" || kind === "float") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (kind === "bigint") return String(raw ?? "0");
  if (kind === "enum") return raw; // enum string name; fromJson accepts the name
  return String(raw ?? ""); // string / bytes (base64)
}

/** Render one leaf field's value as a plain string for display (diff
 * tables, previews) -- not an input. */
export function formatValue(value) {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inputControl(fullPath, classified, currentValue, { disabled, sensitive } = {}) {
  const { kind, repeated, enumValues } = classified;
  const dis = disabled ? "disabled" : "";
  const dataAttrs = `data-action="set-managed-value" data-path="${escapeHtml(fullPath)}"`;

  if (repeated) {
    const text = Array.isArray(currentValue) ? currentValue.join("\n") : "";
    return `<textarea rows="3" ${dataAttrs} data-kind="${kind}" data-repeated="1" ${dis}
      placeholder="one value per line">${escapeHtml(text)}</textarea>`;
  }
  if (kind === "bool") {
    return `<input type="checkbox" ${dataAttrs} data-kind="bool" ${currentValue ? "checked" : ""} ${dis} />`;
  }
  if (kind === "enum") {
    const opts = enumValues.map((v) =>
      `<option value="${escapeHtml(v.name)}" ${currentValue === v.name ? "selected" : ""}>${escapeHtml(v.name)}</option>`
    ).join("");
    return `<select ${dataAttrs} data-kind="enum" ${dis}>${opts}</select>`;
  }
  if (kind === "int" || kind === "float") {
    return `<input type="number" ${kind === "float" ? 'step="any"' : ""} ${dataAttrs} data-kind="${kind}"
      value="${currentValue ?? ""}" ${dis} />`;
  }
  if (sensitive) {
    const revealed = currentValue != null && currentValue !== "";
    return `<span class="secret-field">
      <input type="password" ${dataAttrs} data-kind="${kind}" value="${escapeHtml(currentValue ?? "")}" ${dis}
        placeholder="base64" autocomplete="off" />
      ${revealed ? `<button type="button" data-action="reveal-secret" data-path="${escapeHtml(fullPath)}">reveal</button>` : ""}
    </span>`;
  }
  return `<input type="text" ${dataAttrs} data-kind="${kind}" value="${escapeHtml(currentValue ?? "")}" ${dis} />`;
}

/**
 * Render editable rows for a message schema's fields under `basePath`
 * (e.g. "config.position"), bound to a global profile's managed-field
 * state. `only` restricts to specific localNames (curated sections);
 * omit for every field (Advanced tree). Nested message fields recurse
 * into a <fieldset>, except when `flatten` lists a localName to inline
 * without its own fieldset wrapper (used for e.g. Channel.settings).
 */
export function renderSectionFields(schema, basePath, profile, { only, skip, depth = 0 } = {}) {
  const fields = schema.fields.filter((f) => {
    if (only && !only.includes(f.localName)) return false;
    if (skip && skip.includes(f.localName)) return false;
    return true;
  });
  return fields.map((field) => renderFieldRow(field, basePath, profile, depth)).join("\n");
}

function renderFieldRow(field, basePath, profile, depth) {
  const fullPath = `${basePath}.${field.localName}`;
  const classified = classifyField(field);
  const label = humanize(field.localName);

  if (classified.kind === "message" && !classified.repeated) {
    const inner = renderSectionFields(classified.messageSchema, fullPath, profile, { depth: depth + 1 });
    return `<fieldset class="nested-fields" style="--depth:${depth}">
      <legend>${escapeHtml(label)}</legend>
      ${inner || '<p class="muted">No fields.</p>'}
    </fieldset>`;
  }
  if (classified.kind === "message" && classified.repeated) {
    // Repeated message fields (e.g. remoteHardware.availablePins) are rare
    // in the sections this app manages; fall back to raw JSON editing
    // rather than building recursive repeated-group UI for them.
    const current = managedValue(profile, fullPath);
    const managed = isManaged(profile, fullPath);
    return renderRow(fullPath, label, managed, `<textarea rows="3" data-action="set-managed-json" data-path="${escapeHtml(fullPath)}"
      ${managed ? "" : "disabled"} placeholder="JSON array">${escapeHtml(current !== undefined ? JSON.stringify(current) : "[]")}</textarea>`, null);
  }
  if (classified.kind === "unsupported") {
    return `<div class="field-row unsupported"><span class="field-label">${escapeHtml(label)}</span>
      <span class="muted">(unsupported field type, not editable here)</span></div>`;
  }

  const managed = isManaged(profile, fullPath);
  const current = managed ? managedValue(profile, fullPath) : undefined;
  const sensitive = isSensitiveField(field.localName);
  const control = inputControl(fullPath, classified, current, { disabled: !managed, sensitive });
  return renderRow(fullPath, label, managed, control, sensitive);
}

function renderRow(fullPath, label, managed, controlHtml, sensitive) {
  return `<div class="field-row${sensitive ? " sensitive" : ""}">
    <label class="field-manage">
      <input type="checkbox" data-action="toggle-managed" data-path="${escapeHtml(fullPath)}" ${managed ? "checked" : ""} />
      <span class="field-label">${escapeHtml(label)}</span>
    </label>
    <span class="field-control">${controlHtml}</span>
  </div>`;
}
