// Firmware defaults: the zero-value protobuf baseline, plus a small table
// of human-readable notes for fields where "0" doesn't mean zero -- it
// means "use the firmware's built-in default", and that default is a
// specific non-zero number.
//
// The zero-value baseline itself needs no per-field knowledge: a device
// stores 0/""/false for "unset" and the firmware substitutes its runtime
// default, so create(Schema) is *exactly* what a factory-fresh field
// looks like on the wire. That's semantically correct for every field,
// annotated or not -- the annotation table below only adds a friendly
// "-> firmware uses N" label for a handful of fields we've traced to a
// specific `default_..._secs` constant in the firmware source, so a raw
// "0" in the diff view doesn't read as "broadcast disabled".
import { toJson } from "@bufbuild/protobuf";
import { getConfigSections, getModuleConfigSections, zeroValue } from "./schema.js";

// Transcribed from meshtastic/firmware `src/mesh/Default.h` and the exact
// call sites that apply each constant, confirmed by reading
// NodeInfoModule.cpp:225, NeighborInfoModule.cpp:134 and
// PositionModule.cpp:383 on the `master` branch. Values shown are the
// non-router defaults (IF_ROUTER(...) picks a different value for
// ROUTER-role nodes, which isn't relevant for the T1000-E's tracker role).
export const FIRMWARE_DEFAULT_NOTES = {
  "config.device.nodeInfoBroadcastSecs": { value: 10800, note: "firmware default: every 3 hours" },
  "config.position.positionBroadcastSecs": { value: 3600, note: "firmware default: every 1 hour" },
  "moduleConfig.neighborInfo.updateInterval": { value: 21600, note: "firmware default: every 6 hours" },
};

export function firmwareDefaultNote(sectionPath, fieldLocalName) {
  return FIRMWARE_DEFAULT_NOTES[`${sectionPath}.${fieldLocalName}`] ?? null;
}

/** { config: { device: {...}, position: {...}, ... }, moduleConfig: {...} }
 * with every section at its protobuf zero value, JSON-encoded. */
export function zeroBaseline() {
  const config = {};
  for (const section of getConfigSections()) {
    config[section.key] = toJson(section.schema, zeroValue(section.schema));
  }
  const moduleConfig = {};
  for (const section of getModuleConfigSections()) {
    moduleConfig[section.key] = toJson(section.schema, zeroValue(section.schema));
  }
  // Ringtone isn't a Config/ModuleConfig section (see snapshot.js's
  // fetchRingtone()), so there's no schema to reflect a zero-value from --
  // hardcoded to "", the proto3 default for a string field.
  return { config, moduleConfig, ringtone: "" };
}
