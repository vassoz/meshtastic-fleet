// Builds and executes a write plan: merges a global + local profile into
// a target state, diffs it against a *fresh* snapshot of the connected
// device, and writes only what actually changed -- as one begin/commit
// transaction, so it's a single flash save and a single reboot.
//
// The one thing this module cannot skip: firmware AdminModule.cpp
// replaces an entire Config/ModuleConfig/Channel section wholesale on
// write (`config.position = c.payload_variant.position;` etc, confirmed
// by reading the firmware source) -- there is no field-level merge on the
// device side. So for every section we touch, the outgoing message must
// be "the device's current section, with only the managed fields
// overlaid" (see overlayPaths in util.js), never "just the managed
// fields alone". Getting this wrong would silently reset every
// unmanaged field in that section back to its firmware default.
//
// setOwner and setFixedPosition/removeFixedPosition are different: the
// firmware handles those field-by-field (setOwner: `if (*o.long_name)`)
// or narrowly (setFixedPosition only ever touches position + the
// fixed_position flag), so they're sent directly without a merge step.
import { create, fromJson, toBinary } from "@bufbuild/protobuf";
import {
  Protobuf,
  ChannelSchema,
  UserSchema,
  getConfigSectionSchema,
  getModuleConfigSectionSchema,
} from "./schema.js";
import { managedBySection } from "./profiles.js";
import { getPath, setPath, deepClone, overlayPaths, stripUndefinedDeep } from "./util.js";
import { deepDiffLeaves } from "./diff.js";

const SECTIONS_REQUIRING_REPAIR_WARNING = new Set(["config.lora", "config.bluetooth"]);

/**
 * Merge a global profile's managed fields with a local profile's identity
 * fields into one target tree, then diff each touched section against the
 * device's current snapshot to build a minimal write plan.
 *
 * @returns {{
 *   ownerJson: object|null,
 *   fixedPosition: {latitude:number, longitude:number, altitude?:number}|null,
 *   removeFixedPositionRequested: boolean,
 *   channelWrites: {index:number, msg:object, preview:object[]}[],
 *   configWrites: {key:string, msg:object, preview:object[]}[],
 *   moduleConfigWrites: {key:string, msg:object, preview:object[]}[],
 *   needsRepairWarning: boolean,
 *   isEmpty: boolean,
 * }}
 */
export function buildWritePlan(globalProfile, localProfile, deviceSnapshot) {
  // 1. Merge: start from the global profile's managed paths/data, then
  // overlay the local profile's contributions (which always win on
  // collision -- e.g. config.security.privateKey is local-only, but if a
  // global profile ever tried to manage it too, local should win).
  const mergedPaths = [...(globalProfile?.managedPaths ?? [])];
  const mergedData = deepClone(globalProfile?.data) ?? { config: {}, moduleConfig: {}, channels: {} };

  function addLocalPath(path, value) {
    if (value === undefined || value === null || value === "") return;
    if (!mergedPaths.includes(path)) mergedPaths.push(path);
    setPath(mergedData, path, value);
  }

  if (localProfile?.security?.privateKey) {
    addLocalPath("config.security.privateKey", localProfile.security.privateKey);
  }
  if (localProfile?.bluetooth?.fixedPin != null) {
    addLocalPath("config.bluetooth.fixedPin", localProfile.bluetooth.fixedPin);
  }

  const grouped = managedBySection({ managedPaths: mergedPaths, data: mergedData });

  const configWrites = [];
  const moduleConfigWrites = [];
  const channelWrites = [];
  let needsRepairWarning = false;

  for (const [sectionRef, fieldPaths] of Object.entries(grouped)) {
    const [area, sectionKey] = sectionRef.split(".");
    if (area === "channels") continue; // handled in the pass below
    const schema = area === "config" ? getConfigSectionSchema(sectionKey) : getModuleConfigSectionSchema(sectionKey);
    if (!schema) continue;
    const currentJson = deviceSnapshot?.[area]?.[sectionKey] ?? {};
    const overrides = getPath(mergedData, `${area}.${sectionKey}`) ?? {};
    // stripUndefinedDeep: a managed field promoted from a device where it
    // sat at its protobuf zero value has no stored value (proto3 JSON
    // omits it) -- normalize back to "absent" so fromJson() resolves it
    // to the correct zero value instead of choking on a raw `undefined`.
    const mergedJson = stripUndefinedDeep(overlayPaths(currentJson, overrides, fieldPaths));
    const preview = [...deepDiffLeaves(currentJson, mergedJson)].map(({ path, a, b }) => ({
      fieldPath: path.join("."),
      from: a,
      to: b,
    }));
    if (preview.length === 0) continue; // already matches; nothing to write
    if (SECTIONS_REQUIRING_REPAIR_WARNING.has(sectionRef)) needsRepairWarning = true;
    const sectionMsg = fromJson(schema, mergedJson);
    // device.setConfig()/setModuleConfig() both dereference
    // `payloadVariant.case` themselves (confirmed in the vendored
    // source), so they need the top-level Config/ModuleConfig oneof
    // wrapper around the section message, not the bare section message
    // fromJson(getConfigSectionSchema(...), ...) produces on its own.
    const wrapperSchema = area === "config" ? Protobuf.Config.ConfigSchema : Protobuf.ModuleConfig.ModuleConfigSchema;
    const msg = create(wrapperSchema, { payloadVariant: { case: sectionKey, value: sectionMsg } });
    if (area === "config") configWrites.push({ key: sectionKey, msg, preview });
    else moduleConfigWrites.push({ key: sectionKey, msg, preview });
  }

  // Channels: same overlay approach, but the outgoing Channel message
  // needs its `index` set explicitly (Channels::setChannel keys off it).
  const channelFieldsByIndex = {};
  for (const [sectionRef, fieldPaths] of Object.entries(grouped)) {
    const [area, idx] = sectionRef.split(".");
    if (area !== "channels") continue;
    channelFieldsByIndex[idx] = fieldPaths;
  }
  for (const [idx, fieldPaths] of Object.entries(channelFieldsByIndex)) {
    const currentJson = deviceSnapshot?.channels?.[idx] ?? {};
    const overrides = getPath(mergedData, `channels.${idx}`) ?? {};
    const mergedJson = stripUndefinedDeep({ ...overlayPaths(currentJson, overrides, fieldPaths), index: Number(idx) });
    const preview = [...deepDiffLeaves(currentJson, mergedJson)]
      .filter(({ path }) => path.join(".") !== "index" || currentJson.index !== Number(idx))
      .map(({ path, a, b }) => ({ fieldPath: path.join("."), from: a, to: b }));
    if (preview.length === 0) continue;
    const msg = fromJson(ChannelSchema, mergedJson);
    channelWrites.push({ index: Number(idx), msg, preview });
  }

  // Owner: field-level-safe on the device, no read-modify-write needed.
  let ownerJson = null;
  if (localProfile?.owner && (localProfile.owner.longName || localProfile.owner.shortName)) {
    const current = deviceSnapshot?.owner ?? {};
    const candidate = {
      longName: localProfile.owner.longName || current.longName,
      shortName: localProfile.owner.shortName || current.shortName,
      isLicensed: !!localProfile.owner.isLicensed,
    };
    const changed = candidate.longName !== current.longName ||
      candidate.shortName !== current.shortName ||
      candidate.isLicensed !== !!current.isLicensed;
    if (changed) ownerJson = candidate;
  }

  // Fixed position: dedicated narrow admin calls, not a config-section
  // write (setFixedPosition/removeFixedPosition only ever touch position +
  // the fixed_position flag -- confirmed against AdminModule.cpp). Only
  // acted on when it actually changes anything, using the self-node
  // Position captured in the snapshot (see snapshot.js) as "current".
  let fixedPosition = null;
  let removeFixedPositionRequested = false;
  if (localProfile?.fixedPosition) {
    const fp = localProfile.fixedPosition;
    const current = deviceSnapshot?.position ?? {};
    const changed = current.latitudeI !== fp.latitudeI ||
      current.longitudeI !== fp.longitudeI ||
      (fp.altitude != null && current.altitude !== fp.altitude);
    if (changed) {
      fixedPosition = {
        latitude: fp.latitudeI * 1e-7,
        longitude: fp.longitudeI * 1e-7,
        altitude: fp.altitude,
      };
    }
  } else if (localProfile?.clearFixedPosition && deviceSnapshot?.config?.position?.fixedPosition) {
    removeFixedPositionRequested = true;
  }

  // Ringtone: another dedicated narrow admin call (setRingtoneMessage),
  // not a config-section field -- see snapshot.js's fetchRingtone() for
  // why reading it needs manual packet handling. Fleet-wide, not
  // per-device, so it lives on the global profile (promoted from Read's
  // diff view, managedPath "ringtone" -- see readView.js), not the local
  // one. Only acted on when it differs from what's currently on the device.
  let ringtone = null;
  if (globalProfile?.managedPaths?.includes("ringtone")) {
    const value = globalProfile.data?.ringtone;
    if (value && value !== (deviceSnapshot?.ringtone ?? "")) {
      ringtone = value;
    }
  }

  const isEmpty = configWrites.length === 0 && moduleConfigWrites.length === 0 &&
    channelWrites.length === 0 && !ownerJson && !fixedPosition && !removeFixedPositionRequested && !ringtone;

  return {
    ownerJson,
    fixedPosition,
    removeFixedPositionRequested,
    ringtone,
    channelWrites,
    configWrites,
    moduleConfigWrites,
    needsRepairWarning,
    isEmpty,
  };
}

async function sendFixedPosition(device, { latitude, longitude, altitude }) {
  const fields = {
    latitudeI: Math.floor(latitude / 1e-7),
    longitudeI: Math.floor(longitude / 1e-7),
  };
  if (altitude != null && Number.isFinite(altitude)) fields.altitude = Math.round(altitude);
  const position = create(Protobuf.Mesh.PositionSchema, fields);
  const msg = create(Protobuf.Admin.AdminMessageSchema, {
    payloadVariant: { case: "setFixedPosition", value: position },
  });
  return device.sendPacket(
    toBinary(Protobuf.Admin.AdminMessageSchema, msg),
    Protobuf.Portnums.PortNum.ADMIN_APP,
    "self",
    0,
    true,
    false,
  );
}

async function sendRingtone(device, ringtone) {
  const msg = create(Protobuf.Admin.AdminMessageSchema, {
    payloadVariant: { case: "setRingtoneMessage", value: ringtone },
  });
  return device.sendPacket(
    toBinary(Protobuf.Admin.AdminMessageSchema, msg),
    Protobuf.Portnums.PortNum.ADMIN_APP,
    "self",
    0,
    true,
    false,
  );
}

/** Executes a write plan as one begin/commit transaction. `onLog(message)`
 * is called before each step for progress display. */
export async function executeWritePlan(device, plan, { onLog } = {}) {
  const log = (msg) => onLog?.(msg);

  log("Opening edit transaction (beginEditSettings)");
  await device.beginEditSettings();

  if (plan.ownerJson) {
    log("Writing owner (name)");
    await device.setOwner(fromJson(UserSchema, plan.ownerJson));
  }
  for (const ch of plan.channelWrites) {
    log(`Writing channel ${ch.index}`);
    await device.setChannel(ch.msg);
  }
  for (const c of plan.configWrites) {
    log(`Writing config.${c.key}`);
    await device.setConfig(c.msg);
  }
  for (const mc of plan.moduleConfigWrites) {
    log(`Writing moduleConfig.${mc.key}`);
    await device.setModuleConfig(mc.msg);
  }
  if (plan.removeFixedPositionRequested) {
    log("Removing fixed position");
    await device.removeFixedPosition();
  } else if (plan.fixedPosition) {
    log("Writing fixed position");
    await sendFixedPosition(device, plan.fixedPosition);
  }
  if (plan.ringtone != null) {
    log("Writing ringtone");
    await sendRingtone(device, plan.ringtone);
  }

  log("Committing (commitEditSettings) — device will save and reboot");
  await device.commitEditSettings();
}

/** Compare a post-write snapshot against the plan's intended values.
 * Returns per-field {fieldPath, expected, actual, ok} rows. Mismatches are
 * reported, not thrown -- some (e.g. lora.txPower clamped to a regional
 * cap) are expected firmware behaviour, not failures. */
export function verifyWritePlan(plan, postSnapshot) {
  const rows = [];
  const sections = [
    ...plan.configWrites.map((w) => ({ area: "config", key: w.key, preview: w.preview })),
    ...plan.moduleConfigWrites.map((w) => ({ area: "moduleConfig", key: w.key, preview: w.preview })),
    ...plan.channelWrites.map((w) => ({ area: "channels", key: String(w.index), preview: w.preview })),
  ];
  for (const section of sections) {
    const actualJson = postSnapshot?.[section.area]?.[section.key] ?? {};
    for (const { fieldPath, to } of section.preview) {
      const actual = getPath(actualJson, fieldPath);
      const ok = JSON.stringify(actual) === JSON.stringify(to);
      rows.push({ area: section.area, sectionKey: section.key, fieldPath, expected: to, actual, ok });
    }
  }
  if (plan.ownerJson) {
    for (const key of ["longName", "shortName", "isLicensed"]) {
      const expected = plan.ownerJson[key];
      const actual = postSnapshot?.owner?.[key];
      rows.push({ area: "owner", sectionKey: "owner", fieldPath: key, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
    }
  }
  if (plan.fixedPosition) {
    const expectedLatI = Math.floor(plan.fixedPosition.latitude / 1e-7);
    const expectedLonI = Math.floor(plan.fixedPosition.longitude / 1e-7);
    const actual = postSnapshot?.position ?? {};
    rows.push({ area: "position", sectionKey: "position", fieldPath: "latitudeI", expected: expectedLatI, actual: actual.latitudeI, ok: actual.latitudeI === expectedLatI });
    rows.push({ area: "position", sectionKey: "position", fieldPath: "longitudeI", expected: expectedLonI, actual: actual.longitudeI, ok: actual.longitudeI === expectedLonI });
  }
  if (plan.removeFixedPositionRequested) {
    const actual = postSnapshot?.config?.position?.fixedPosition ?? false;
    rows.push({ area: "position", sectionKey: "position", fieldPath: "fixedPosition", expected: false, actual, ok: actual === false });
  }
  if (plan.ringtone != null) {
    const actual = postSnapshot?.ringtone ?? null;
    rows.push({ area: "ringtone", sectionKey: "ringtone", fieldPath: "ringtone", expected: plan.ringtone, actual, ok: actual === plan.ringtone });
  }
  return rows;
}
