// Write tab: pick a global + local profile, preview the exact plan
// (already diffed against a fresh read of the connected device -- see
// writer.js), confirm, then watch it execute, reboot, reconnect and
// verify.
import { listGlobalProfiles, listLocalProfiles, upsertGlobalProfile, deleteGlobalProfile, touch } from "../profiles.js";
import { buildWritePlan } from "../writer.js";
import { escapeHtml, getPath } from "../util.js";
import { formatValue } from "./fields.js";

export function render(state) {
  if (state.connectionStatus !== "connected" || !state.liveSnapshot) {
    return `<section class="view write-view">
      <h2>Write</h2>
      <p class="muted">Connect a device and let it finish reading (see the Read tab) before building a write plan --
        every write is diffed against a fresh copy of the device's current state.</p>
    </section>`;
  }

  const globalProfiles = listGlobalProfiles(state.store);
  const localProfiles = listLocalProfiles(state.store);
  const picker = `<div class="write-pickers">
    <label class="row">Global profile
      <select data-action="set-write-global">
        <option value="">— none —</option>
        ${globalProfiles.map((p) => `<option value="${p.id}" ${state.ui.writeGlobalId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>
    </label>
    <label class="row">Local profile
      <select data-action="set-write-local">
        <option value="">— none —</option>
        ${localProfiles.map((p) => `<option value="${p.id}" ${state.ui.writeLocalId === p.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
      </select>
    </label>
    <button type="button" data-action="build-write-plan">Build plan</button>
  </div>`;

  if (state.ui.busy) {
    return `<section class="view write-view">
      <h2>Write</h2>
      ${picker}
      <div class="write-log">${state.ui.writeLog.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>
    </section>`;
  }

  const plan = state.ui.writePlan;
  const globalProfile = state.ui.writeGlobalId ? state.store.globalProfiles[state.ui.writeGlobalId] : null;
  const localProfile = state.ui.writeLocalId ? state.store.localProfiles[state.ui.writeLocalId] : null;
  return `<section class="view write-view">
    <h2>Write</h2>
    ${renderDangerZone(state)}
    ${picker}
    ${renderGlobalProfileSummary(globalProfile)}
    ${plan ? renderPlan(plan, globalProfile, localProfile) : ""}
    ${state.ui.writeLog.length ? `<div class="write-log"><h3>Log</h3>${state.ui.writeLog.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>` : ""}
    ${state.ui.writeVerify ? renderVerify(state.ui.writeVerify) : ""}
  </section>`;
}

function renderDangerZone(state) {
  const name = state.connection?.bleDevice?.name ?? "this device";
  return `<div class="row-actions danger-zone danger-zone-top">
    <button type="button" class="danger" data-action="factory-reset">Factory reset ${escapeHtml(name)}…</button>
  </div>`;
}

// There's no dedicated Global profile editor -- a profile is built purely
// by reading a reference device and promoting selected fields (Read tab).
// This is the only place left to see what's actually in one, rename it,
// or delete it. Read-only on purpose: the point of removing the manual
// editor was to stop hand-typing values here.
function renderGlobalProfileSummary(globalProfile) {
  if (!globalProfile) return "";
  const rows = [...globalProfile.managedPaths].sort().map((path) => {
    const value = getPath(globalProfile.data, path);
    return `<tr><td>${escapeHtml(path)}</td><td>${escapeHtml(formatValue(value))}</td></tr>`;
  }).join("");
  return `<div class="profile-summary">
    <div class="row-actions">
      <input type="text" data-action="rename-global-profile" data-id="${globalProfile.id}" value="${escapeHtml(globalProfile.name)}" />
      <button type="button" class="danger" data-action="delete-global-profile-from-write" data-id="${globalProfile.id}">Delete profile</button>
    </div>
    <p class="muted">${globalProfile.managedPaths.length} field(s) managed${globalProfile.managedPaths.length ? ":" : " -- promote some from the Read tab."}</p>
    ${globalProfile.managedPaths.length ? `<table class="diff-table"><tbody>${rows}</tbody></table>` : ""}
  </div>`;
}

function renderPlan(plan, globalProfile, localProfile) {
  if (plan.isEmpty) {
    const globalManages = globalProfile?.managedPaths?.length > 0;
    const localSetsSomething = !!(localProfile?.owner?.longName || localProfile?.owner?.shortName ||
      localProfile?.security?.privateKey || localProfile?.fixedPosition || localProfile?.bluetooth || localProfile?.clearFixedPosition);
    let reason;
    if (!globalProfile && !localProfile) {
      reason = "no global or local profile is selected above.";
    } else if (!globalManages && !localSetsSomething) {
      reason = "the selected profile(s) don't manage any fields yet -- go to Read, connect a reference device, " +
        "and check off which fields to promote into this profile, or fill in a name/key/position in the Local tab.";
    } else {
      reason = "every field the selected profile(s) manage already matches what's on the device.";
    }
    return `<div class="plan-panel"><p class="muted">Nothing to write — ${reason}</p></div>`;
  }

  const sectionBlock = (title, writes, prefix) => writes.length === 0 ? "" : `<h4>${title}</h4>` +
    writes.map((w) => `<div class="plan-section">
      <strong>${prefix}${escapeHtml(String(w.key ?? w.index))}</strong>
      <table class="diff-table"><tbody>
        ${w.preview.map((p) => `<tr><td>${escapeHtml(p.fieldPath)}</td><td>${escapeHtml(formatValue(p.from))}</td><td>→</td><td>${escapeHtml(formatValue(p.to))}</td></tr>`).join("")}
      </tbody></table>
    </div>`).join("");

  return `<div class="plan-panel">
    ${plan.needsRepairWarning ? `<div class="banner warn">This plan changes LoRa or Bluetooth settings — the device may need to be re-paired after it reboots.</div>` : ""}
    ${plan.ownerJson ? `<div class="plan-section"><strong>Owner</strong>
      <table class="diff-table"><tbody>
        <tr><td>longName</td><td>${escapeHtml(plan.ownerJson.longName ?? "")}</td></tr>
        <tr><td>shortName</td><td>${escapeHtml(plan.ownerJson.shortName ?? "")}</td></tr>
        <tr><td>isLicensed</td><td>${plan.ownerJson.isLicensed}</td></tr>
      </tbody></table></div>` : ""}
    ${plan.fixedPosition ? `<div class="plan-section"><strong>Fixed position</strong>
      <p>${plan.fixedPosition.latitude}, ${plan.fixedPosition.longitude}${plan.fixedPosition.altitude != null ? ` @ ${plan.fixedPosition.altitude}m` : ""}</p></div>` : ""}
    ${plan.removeFixedPositionRequested ? `<div class="plan-section"><strong>Fixed position</strong><p>will be cleared</p></div>` : ""}
    ${sectionBlock("Channels", plan.channelWrites, "Channel ")}
    ${sectionBlock("Config", plan.configWrites, "config.")}
    ${sectionBlock("Module config", plan.moduleConfigWrites, "moduleConfig.")}
    <div class="row-actions">
      <button type="button" class="primary" data-action="confirm-write">Write to device</button>
    </div>
  </div>`;
}

function renderVerify(rows) {
  const ok = rows.filter((r) => r.ok).length;
  return `<div class="verify-panel">
    <h3>Verification: ${ok}/${rows.length} fields match</h3>
    <table class="diff-table">
      <thead><tr><th></th><th>Section</th><th>Field</th><th>Expected</th><th>Actual</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.ok ? "ok" : "mismatch"}">
        <td>${r.ok ? "✓" : "✗"}</td>
        <td>${escapeHtml(r.area)}.${escapeHtml(r.sectionKey)}</td>
        <td>${escapeHtml(r.fieldPath)}</td>
        <td>${escapeHtml(formatValue(r.expected))}</td>
        <td>${escapeHtml(formatValue(r.actual))}</td>
      </tr>`).join("")}</tbody>
    </table>
  </div>`;
}

export function onAction(state, action, target) {
  switch (action) {
    case "set-write-global":
      state.ui.writeGlobalId = target.value || null;
      state.ui.writePlan = null;
      return true;
    case "set-write-local":
      state.ui.writeLocalId = target.value || null;
      state.ui.writePlan = null;
      return true;
    case "build-write-plan": {
      const globalProfile = state.ui.writeGlobalId ? state.store.globalProfiles[state.ui.writeGlobalId] : null;
      const localProfile = state.ui.writeLocalId ? state.store.localProfiles[state.ui.writeLocalId] : null;
      if (!globalProfile && !localProfile) {
        state.ui.error = "Pick at least one profile to write.";
        return true;
      }
      state.ui.writePlan = buildWritePlan(globalProfile, localProfile, state.liveSnapshot);
      state.ui.writeVerify = null;
      state.ui.writeLog = [];
      return true;
    }
    case "confirm-write": {
      if (!state.ui.writePlan || state.ui.writePlan.isEmpty) return true;
      if (!confirm("Write this plan to the connected device? It will reboot once when done.")) return true;
      return { asyncAction: "execute-write" };
    }
    case "rename-global-profile": {
      const profile = state.store.globalProfiles[target.dataset.id];
      if (!profile) return true;
      profile.name = target.value || profile.name;
      touch(profile);
      upsertGlobalProfile(state.store, profile);
      return true;
    }
    case "delete-global-profile-from-write": {
      const id = target.dataset.id;
      const profile = state.store.globalProfiles[id];
      if (!profile) return true;
      if (!confirm(`Delete profile "${profile.name}"? This cannot be undone.`)) return true;
      deleteGlobalProfile(state.store, id);
      if (state.ui.writeGlobalId === id) state.ui.writeGlobalId = null;
      state.ui.writePlan = null;
      return true;
    }
    case "factory-reset": {
      const name = state.connection?.bleDevice?.name ?? "this device";
      const confirmed = confirm(
        `Factory reset ${name}?\n\n` +
        "This erases ALL configuration, channels, PKI keys, and node data, and cannot be undone -- the device " +
        "reboots as if freshly flashed. If you haven't already, capture its current private key via Read -> " +
        "Local identity before doing this, or it's gone.\n\n" +
        "Continue?",
      );
      if (!confirmed) return true;
      return { asyncAction: "factory-reset" };
    }
    default:
      return false;
  }
}
