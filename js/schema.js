// Reflection over @meshtastic/core's bundled @bufbuild/protobuf runtime
// descriptors: enumerates the writable Config/ModuleConfig sections
// directly from the schema compiled into the app, so a firmware/protobuf
// bump that adds a section is picked up without a code change here.
import { Protobuf } from "@meshtastic/core";
import { create } from "@bufbuild/protobuf";

// Config.payloadVariant members that aren't meaningful to read/write from
// this app: `sessionkey` is ephemeral PKI session state the firmware never
// actually returns (AdminModule.cpp sends an empty payload for it), and
// `deviceUi` configures the physical touchscreen UI that the T1000-E (and
// most Meshtastic hardware) doesn't have.
const CONFIG_SECTION_EXCLUDE = new Set(["sessionkey", "deviceUi"]);

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

/** The zero-value ("unset") message for a schema, as a plain JS instance. */
export function zeroValue(schema) {
  return create(schema);
}

export { Protobuf, humanize };
