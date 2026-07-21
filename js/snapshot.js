// Captures a full DeviceSnapshot by subscribing to MeshDevice's event
// streams *before* calling configure() -- configure() triggers a
// wantConfig request, and the firmware answers with the entire device
// state (Config sections, ModuleConfig sections, every channel, the node
// database including our own NodeInfo/User, and finally a
// config-complete marker) as one continuous stream of FromRadio packets.
//
// Confirmed against firmware source (AdminModule.cpp / PhoneAPI.cpp):
// this single stream includes config.security (private + public key)
// unredacted, so one captureSnapshot() call is genuinely everything the
// Read modes need.
import { Types } from "@meshtastic/core";
import { toJson } from "@bufbuild/protobuf";
import {
  getConfigSectionSchema,
  getModuleConfigSectionSchema,
  ChannelSchema,
  UserSchema,
  PositionSchema,
} from "./schema.js";

/**
 * @param {import("@meshtastic/core").MeshDevice} device
 * @param {{ timeoutMs?: number, onProgress?: (label: string) => void }} [opts]
 * @returns {Promise<object>} a DeviceSnapshot
 */
export function captureSnapshot(device, { timeoutMs = 30000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const snap = {
      capturedAt: new Date().toISOString(),
      nodeNum: null,
      firmwareVersion: null,
      hwModel: null,
      config: {},
      moduleConfig: {},
      channels: {},
      owner: null,
      // Last-known/fixed position for our own node, from the node database
      // entry (NodeInfo.position) -- lets Read/Write verify fixed-position
      // writes without a separate request.
      position: null,
    };
    const nodeInfos = new Map();
    const unsubs = [];

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for device configuration (${timeoutMs}ms). ` +
        "Make sure the device is powered on, in range, and not already connected elsewhere."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      for (const u of unsubs) u();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    async function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      const self = snap.nodeNum != null ? nodeInfos.get(snap.nodeNum) : null;
      if (self?.user) {
        snap.owner = toJson(UserSchema, self.user);
        snap.hwModel = snap.owner.hwModel ?? null;
      }
      if (self?.position) {
        snap.position = toJson(PositionSchema, self.position);
      }
      try {
        await fetchMetadata();
      } catch (err) {
        console.warn("Could not fetch device metadata (non-fatal)", err);
      }
      resolve(snap);
    }

    function fetchMetadata() {
      return new Promise((res) => {
        if (snap.nodeNum == null) {
          res();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(to);
          metaUnsub();
          res();
        };
        const to = setTimeout(finish, 5000);
        const metaUnsub = device.events.onDeviceMetadataPacket.subscribe((pkt) => {
          snap.firmwareVersion = pkt?.data?.firmwareVersion || null;
          finish();
        });
        device.getMetadata(snap.nodeNum).catch(finish);
      });
    }

    unsubs.push(device.events.onConfigPacket.subscribe((cfg) => {
      const kase = cfg.payloadVariant.case;
      if (!kase) return;
      const schema = getConfigSectionSchema(kase);
      if (!schema) return; // sessionkey / deviceUi: not tracked by this app
      snap.config[kase] = toJson(schema, cfg.payloadVariant.value);
      onProgress?.(`config.${kase}`);
    }));

    unsubs.push(device.events.onModuleConfigPacket.subscribe((mc) => {
      const kase = mc.payloadVariant.case;
      if (!kase) return;
      const schema = getModuleConfigSectionSchema(kase);
      if (!schema) return;
      snap.moduleConfig[kase] = toJson(schema, mc.payloadVariant.value);
      onProgress?.(`moduleConfig.${kase}`);
    }));

    unsubs.push(device.events.onChannelPacket.subscribe((ch) => {
      snap.channels[String(ch.index)] = toJson(ChannelSchema, ch);
      onProgress?.(`channel ${ch.index}`);
    }));

    unsubs.push(device.events.onMyNodeInfo.subscribe((info) => {
      snap.nodeNum = info.myNodeNum;
      onProgress?.("myNodeInfo");
    }));

    // The node database dump (part of the same configure() stream) includes
    // our own NodeInfo, which is the authoritative source for owner/User
    // (including the device-derived public key) and hardware model.
    unsubs.push(device.events.onNodeInfoPacket.subscribe((ni) => {
      nodeInfos.set(ni.num, ni);
      onProgress?.(`nodeInfo ${ni.num}`);
    }));

    unsubs.push(device.events.onDeviceStatus.subscribe((status) => {
      if (status === Types.DeviceStatusEnum.DeviceConfigured) {
        succeed();
      } else if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
        fail(new Error("Device disconnected before configuration completed"));
      }
    }));

    device.configure().catch(fail);
  });
}
