// Reflection over @meshtastic/core's bundled @bufbuild/protobuf runtime
// descriptors. This is what makes the "Advanced" section of the config
// editor (and, honestly, most of the curated sections too) not require
// hand-maintained field lists: everything is discovered from the schema
// that's actually compiled into the app, so a firmware/protobuf bump that
// adds a field just makes it show up.
//
// Verified empirically against @meshtastic/core@2.6.7 (see js/main.js
// smoke-test history / README): DescField exposes `localName` (camelCase
// JS property name), `fieldKind` ('scalar'|'enum'|'message'|'list'|'map'),
// `scalar` (a FieldDescriptorProto.Type number) and `enum`/`message`
// (nested descriptors) for the relevant kinds, and for `fieldKind==='list'`
// a `listKind` giving the *element* kind.
import { Protobuf } from "@meshtastic/core";
import { create } from "@bufbuild/protobuf";

// FieldDescriptorProto.Type numbering -- this is the frozen wire-format
// type enum from protobuf itself (unchanged since proto2), not something
// that varies with the Meshtastic schema. Confirmed against live field
// descriptors: STRING=9, BYTES=12, UINT32=13, BOOL=8.
const SCALAR_KIND = {
  1: "float", // DOUBLE
  2: "float", // FLOAT
  3: "bigint", // INT64
  4: "bigint", // UINT64
  5: "int", // INT32
  6: "bigint", // FIXED64
  7: "int", // FIXED32
  8: "bool", // BOOL
  9: "string", // STRING
  12: "bytes", // BYTES
  13: "int", // UINT32
  15: "int", // SFIXED32
  16: "bigint", // SFIXED64
  17: "int", // SINT32
  18: "bigint", // SINT64
};

// Config.payloadVariant members that aren't meaningful to read/write from
// this app: `sessionkey` is ephemeral PKI session state the firmware never
// actually returns (AdminModule.cpp sends an empty payload for it), and
// `deviceUi` configures the physical touchscreen UI that the T1000-E (and
// most Meshtastic hardware) doesn't have.
const CONFIG_SECTION_EXCLUDE = new Set(["sessionkey", "deviceUi"]);

// Field name fragments that should be masked in the UI by default (shown
// as dots with a reveal toggle) because they're cryptographic secrets.
const SENSITIVE_NAME_RE = /private[_-]?key|psk|admin[_-]?key/i;

function humanize(localName) {
  const spaced = localName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
  return spaced;
}

/** All non-oneof, non-excluded top-level Config sections, in schema order. */
export function getConfigSections() {
  return Protobuf.Config.ConfigSchema.fields
    .filter((f) => f.fieldKind === "message" && !CONFIG_SECTION_EXCLUDE.has(f.localName))
    .map((f) => ({ key: f.localName, label: humanize(f.localName), schema: f.message }));
}

/** All ModuleConfig sections, in schema order. */
export function getModuleConfigSections() {
  return Protobuf.ModuleConfig.ModuleConfigSchema.fields
    .filter((f) => f.fieldKind === "message")
    .map((f) => ({ key: f.localName, label: humanize(f.localName), schema: f.message }));
}

export function getConfigSectionSchema(key) {
  return getConfigSections().find((s) => s.key === key)?.schema ?? null;
}

export function getModuleConfigSectionSchema(key) {
  return getModuleConfigSections().find((s) => s.key === key)?.schema ?? null;
}

export const ChannelSchema = Protobuf.Channel.ChannelSchema;
export const ChannelSettingsSchema = Protobuf.Channel.ChannelSettingsSchema;
export const ModuleSettingsSchema = Protobuf.Channel.ModuleSettingsSchema;
export const UserSchema = Protobuf.Mesh.UserSchema;
export const PositionSchema = Protobuf.Mesh.PositionSchema;

/**
 * Classify a DescField into a shape the generic form renderer understands.
 * Returns { kind, repeated, enumValues?, messageSchema? }, where kind is
 * one of: "bool" | "string" | "bytes" | "int" | "bigint" | "float" |
 * "enum" | "message" | "map" | "unsupported".
 */
export function classifyField(field) {
  if (field.fieldKind === "scalar") {
    return { kind: SCALAR_KIND[field.scalar] ?? "unsupported", repeated: false };
  }
  if (field.fieldKind === "enum") {
    return { kind: "enum", repeated: false, enumValues: field.enum.values };
  }
  if (field.fieldKind === "message") {
    return { kind: "message", repeated: false, messageSchema: field.message };
  }
  if (field.fieldKind === "list") {
    if (field.listKind === "enum") {
      return { kind: "enum", repeated: true, enumValues: field.enum.values };
    }
    if (field.listKind === "message") {
      return { kind: "message", repeated: true, messageSchema: field.message };
    }
    return { kind: SCALAR_KIND[field.scalar] ?? "unsupported", repeated: true };
  }
  return { kind: "unsupported", repeated: false };
}

export function isSensitiveField(localName) {
  return SENSITIVE_NAME_RE.test(localName);
}

/** The zero-value ("unset") message for a schema, as a plain JS instance. */
export function zeroValue(schema) {
  return create(schema);
}

export { Protobuf, humanize };
