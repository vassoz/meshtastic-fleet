// Structural diffing over protobuf-JSON trees.
//
// Proto3 JSON encoding omits any field left at its zero value (unless the
// field has explicit `optional` presence), so a captured snapshot's JSON
// is already sparse: a key is present if and only if it differs from the
// wire-level default. That means diffing "snapshot vs firmware defaults"
// and "snapshot vs a saved profile" (which is itself sparse-by-design, see
// profiles.js) are the *same* operation -- a plain recursive structural
// diff of two JSON trees. No schema needed here at all.
import { humanize } from "./schema.js";
import { isPlainObject } from "./util.js";

/** Yields {path: string[], a, b} for every leaf where a and b differ.
 * Nested plain objects are recursed into; arrays and primitives are
 * compared (and reported) as whole values. */
export function* deepDiffLeaves(a, b, prefix = []) {
  const av = isPlainObject(a) ? a : {};
  const bv = isPlainObject(b) ? b : {};
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const key of keys) {
    const path = [...prefix, key];
    const aChild = av[key];
    const bChild = bv[key];
    if (isPlainObject(aChild) || isPlainObject(bChild)) {
      yield* deepDiffLeaves(aChild, bChild, path);
    } else if (JSON.stringify(aChild) !== JSON.stringify(bChild)) {
      yield { path, a: aChild, b: bChild };
    }
  }
}

export function humanizePath(fieldPath) {
  return fieldPath.split(".").map(humanize).join(" › ");
}

/**
 * Diff two { config: {sectionKey: {...}}, moduleConfig: {sectionKey: {...}} }
 * trees. `annotate(area, sectionKey, fieldPath)` may return
 * `{ value, note }` to fill in a friendly baseline label when the
 * baseline side is genuinely absent (i.e. diffing against firmware
 * defaults) -- see defaults.js.
 */
export function diffConfigTrees(baseline, other, { annotate } = {}) {
  const rows = [];
  for (const area of ["config", "moduleConfig"]) {
    const baseArea = baseline[area] || {};
    const otherArea = other[area] || {};
    const sectionKeys = new Set([...Object.keys(baseArea), ...Object.keys(otherArea)]);
    for (const sectionKey of sectionKeys) {
      for (const { path, a, b } of deepDiffLeaves(baseArea[sectionKey], otherArea[sectionKey])) {
        const fieldPath = path.join(".");
        let baselineValue = a;
        let note = null;
        if (annotate && baselineValue === undefined) {
          const found = annotate(area, sectionKey, fieldPath);
          if (found) {
            baselineValue = found.value;
            note = found.note;
          }
        }
        rows.push({
          area,
          sectionKey,
          fieldPath,
          label: humanizePath(fieldPath),
          baselineValue,
          otherValue: b,
          note,
        });
      }
    }
  }
  return rows;
}

/** Diff two { "0": ChannelJson, "1": ChannelJson, ... } maps. */
export function diffChannels(baselineChannels = {}, otherChannels = {}) {
  const rows = [];
  const indices = new Set([...Object.keys(baselineChannels), ...Object.keys(otherChannels)]);
  for (const idx of indices) {
    for (const { path, a, b } of deepDiffLeaves(baselineChannels[idx], otherChannels[idx])) {
      rows.push({
        area: "channels",
        sectionKey: idx,
        channelIndex: Number(idx),
        fieldPath: path.join("."),
        label: humanizePath(path.join(".")),
        baselineValue: a,
        otherValue: b,
      });
    }
  }
  return rows.sort((r1, r2) => r1.channelIndex - r2.channelIndex);
}

/** Diff two flat JSON objects (owner/User, fixed position, ...). */
export function diffFlat(a, b) {
  return [...deepDiffLeaves(a, b)].map(({ path, a: av, b: bv }) => ({
    fieldPath: path.join("."),
    label: humanizePath(path.join(".")),
    baselineValue: av,
    otherValue: bv,
  }));
}
