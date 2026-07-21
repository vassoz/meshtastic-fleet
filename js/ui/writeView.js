// Write tab: pick a global + local profile, preview the exact plan
// (already diffed against a fresh read of the connected device -- see
// writer.js), confirm, then watch it execute, reboot, reconnect and
// verify.
import { listGlobalProfiles, listLocalProfiles } from "../profiles.js";
import { buildWritePlan } from "../writer.js";
import { escapeHtml } from "../util.js";
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
  return `<section class="view write-view">
    <h2>Write</h2>
    ${picker}
    ${plan ? renderPlan(state, plan) : ""}
    ${state.ui.writeLog.length ? `<div class="write-log"><h3>Log</h3>${state.ui.writeLog.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>` : ""}
    ${state.ui.writeVerify ? renderVerify(state.ui.writeVerify) : ""}
  </section>`;
}

function renderPlan(state, plan) {
  if (plan.isEmpty) {
    return `<div class="plan-panel"><p class="muted">Nothing to write — the device already matches the selected profile(s).</p></div>`;
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
    default:
      return false;
  }
}
