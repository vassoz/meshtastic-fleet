// Read tab: capture the connected device's state and either (a) diff its
// global config against a chosen baseline so you can pick what to
// promote into a fleet profile, or (b) show its local identity (names,
// keys, position) so it can be saved as a local profile.
import { diffConfigTrees, diffChannels } from "../diff.js";
import { zeroBaseline, firmwareDefaultNote } from "../defaults.js";
import {
  listGlobalProfiles,
  listLocalProfiles,
  newGlobalProfile,
  newLocalProfile,
  upsertGlobalProfile,
  upsertLocalProfile,
  promoteRows,
  managedValue,
  touch,
} from "../profiles.js";
import { formatValue } from "./fields.js";
import { escapeHtml, formatTimestamp } from "../util.js";
import { connectionLabel } from "../conn.js";

export function render(state) {
  if (state.connectionStatus !== "connected") {
    return `<section class="view read-view">
      <h2>Read</h2>
      <p class="muted">Connect a device (top right) to read its configuration.</p>
    </section>`;
  }
  if (!state.liveSnapshot) {
    return `<section class="view read-view">
      <h2>Read</h2>
      <p class="muted">${escapeHtml(state.ui.busyMessage || "Capturing device configuration…")}</p>
    </section>`;
  }

  const mode = state.ui.readMode || "global";
  return `<section class="view read-view">
    <div class="view-header">
      <h2>Read</h2>
      <div class="row-actions">
        <button type="button" data-action="recapture">Re-read device</button>
        <button type="button" data-action="save-snapshot">Save snapshot for later comparison</button>
      </div>
    </div>
    <div class="section-tabs">
      <button type="button" class="section-tab${mode === "global" ? " active" : ""}" data-action="set-read-mode" data-mode="global">Global config diff</button>
      <button type="button" class="section-tab${mode === "local" ? " active" : ""}" data-action="set-read-mode" data-mode="local">Local identity</button>
    </div>
    ${state.ui.readMessage ? `<p class="muted">${escapeHtml(state.ui.readMessage)}</p>` : ""}
    ${mode === "global" ? renderGlobalDiff(state) : renderLocalRead(state)}
  </section>`;
}

function baselineTree(state) {
  const mode = state.ui.readBaselineMode || "defaults";
  if (mode === "defaults") return { label: "firmware defaults", tree: zeroBaseline() };
  if (mode === "profile") {
    const p = state.store.globalProfiles[state.ui.readBaselineId];
    return {
      label: p ? `profile "${p.name}"` : "(pick a profile)",
      tree: p
        ? { config: unflatten(p, "config"), moduleConfig: unflatten(p, "moduleConfig"), ringtone: managedValue(p, "ringtone") }
        : { config: {}, moduleConfig: {} },
    };
  }
  if (mode === "snapshot") {
    const snap = state.store.snapshots[state.ui.readBaselineId];
    return { label: snap ? `snapshot from ${formatTimestamp(snap.capturedAt)}` : "(pick a snapshot)", tree: snap ?? { config: {}, moduleConfig: {} } };
  }
  return { label: "firmware defaults", tree: zeroBaseline() };
}

// A global profile's `data` tree already mirrors {config:{section:{...}}},
// but only at the specific managed leaf paths -- which is exactly what
// deepDiffLeaves expects to compare against, so no unflattening logic is
// actually needed beyond reading the sub-tree directly.
function unflatten(profile, area) {
  return profile.data[area] ?? {};
}

// Shared by the diff table (renderGlobalDiff), "select all", and "promote
// selected" -- all three need the exact same row set, previously computed
// three separate times (a pre-existing duplication this just also extends
// to cover ringtone rather than adding a fourth copy).
//
// Ringtone gets a synthetic row here rather than flowing through
// diffConfigTrees: it isn't a Config/ModuleConfig field (see snapshot.js's
// fetchRingtone()), so it can't appear in either tree diffConfigTrees
// walks. `managedPath: "ringtone"` tells promoteRows() to store it at that
// bare path instead of the usual `${area}.${sectionKey}.${fieldPath}`
// nesting -- ringtone isn't part of a section, so it doesn't need one.
function computeGlobalDiffRows(state) {
  const { label, tree } = baselineTree(state);
  const snap = state.liveSnapshot;
  const rows = diffConfigTrees(tree, { config: snap.config, moduleConfig: snap.moduleConfig }, {
    annotate: (area, sectionKey, fieldPath) =>
      state.ui.readBaselineMode === "defaults" || !state.ui.readBaselineMode
        ? firmwareDefaultNote(`${area}.${sectionKey}`, fieldPath.split(".")[0])
        : null,
  });
  const channelRows = diffChannels(tree.channels ?? {}, snap.channels);
  const baselineRingtone = tree.ringtone || undefined;
  const otherRingtone = snap.ringtone || undefined;
  const ringtoneRows = baselineRingtone !== otherRingtone ? [{
    area: "ringtone", sectionKey: "ringtone", fieldPath: "ringtone", managedPath: "ringtone",
    label: "Ringtone", baselineValue: baselineRingtone, otherValue: otherRingtone,
  }] : [];
  return { label, allRows: [...rows, ...channelRows, ...ringtoneRows] };
}

function renderGlobalDiff(state) {
  const { label, allRows } = computeGlobalDiffRows(state);
  const globalProfiles = listGlobalProfiles(state.store);
  const snapshots = Object.entries(state.store.snapshots)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""));

  const baselinePicker = `
    <label class="row inline">Compare against
      <select data-action="set-baseline-mode">
        <option value="defaults" ${state.ui.readBaselineMode === "defaults" || !state.ui.readBaselineMode ? "selected" : ""}>Firmware defaults</option>
        <option value="profile" ${state.ui.readBaselineMode === "profile" ? "selected" : ""}>A saved global profile</option>
        <option value="snapshot" ${state.ui.readBaselineMode === "snapshot" ? "selected" : ""}>Another saved snapshot</option>
      </select>
    </label>
    ${state.ui.readBaselineMode === "profile" ? `
      <select data-action="set-baseline-id">
        <option value="">— choose —</option>
        ${globalProfiles.map((p) => `<option value="${p.id}" ${state.ui.readBaselineId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>` : ""}
    ${state.ui.readBaselineMode === "snapshot" ? `
      <select data-action="set-baseline-id">
        <option value="">— choose —</option>
        ${snapshots.map((s) => `<option value="${s.id}" ${state.ui.readBaselineId === s.id ? "selected" : ""}>${escapeHtml(s.label ?? s.id)} (${formatTimestamp(s.capturedAt)})</option>`).join("")}
      </select>` : ""}
    <span class="muted">baseline: ${escapeHtml(label)}</span>`;

  if (allRows.length === 0) {
    return `<div class="diff-panel">${baselinePicker}<p class="muted">No differences from ${escapeHtml(label)}.</p></div>`;
  }

  const rowsHtml = allRows.map((row) => {
    const key = `${row.area}.${row.sectionKey}.${row.fieldPath}`;
    const checked = state.ui.selectedDiffRows.has(key);
    const baselineDisplay = row.baselineValue === undefined
      ? (row.note ? `<span class="muted">unset (${escapeHtml(row.note.note)})</span>` : '<span class="muted">unset</span>')
      : escapeHtml(formatValue(row.baselineValue));
    const sectionLabel = row.area === "channels" ? `${escapeHtml(row.area)} #${row.sectionKey}`
      : row.area === "ringtone" ? escapeHtml(row.area) // not a section -- "ringtone.ringtone" would be redundant
      : `${escapeHtml(row.area)}.${escapeHtml(row.sectionKey)}`;
    return `<tr>
      <td><input type="checkbox" data-action="toggle-diff-row" data-key="${escapeHtml(key)}" ${checked ? "checked" : ""} /></td>
      <td>${sectionLabel}</td>
      <td>${escapeHtml(row.label)}</td>
      <td>${baselineDisplay}</td>
      <td>${escapeHtml(formatValue(row.otherValue))}</td>
    </tr>`;
  }).join("");

  return `<div class="diff-panel">
    ${baselinePicker}
    <div class="row-actions">
      <button type="button" data-action="select-all-diffs">Select all</button>
      <button type="button" data-action="select-none-diffs">Select none</button>
      <select data-action="promote-target-select">
        <option value="new">New global profile…</option>
        ${globalProfiles.map((p) => `<option value="${p.id}" ${state.ui.promoteTargetId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>
      <button type="button" data-action="promote-selected">Promote selected →</button>
    </div>
    <table class="diff-table">
      <thead><tr><th></th><th>Section</th><th>Field</th><th>Baseline</th><th>Device</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
}

function renderLocalRead(state) {
  const snap = state.liveSnapshot;
  const revealed = state.ui.revealedSecrets.has("read.privateKey");
  const owner = snap.owner ?? {};
  const boundProfile = listLocalProfiles(state.store).find((p) => p.boundTo?.nodeNum === snap.nodeNum);

  return `<div class="read-local-panel">
    <dl>
      <dt>Node number</dt><dd>#${snap.nodeNum ?? "?"}</dd>
      <dt>Hardware model</dt><dd>${escapeHtml(snap.hwModel ?? "—")}</dd>
      <dt>Firmware</dt><dd>${escapeHtml(snap.firmwareVersion ?? "—")}</dd>
      <dt>Long name</dt><dd>${escapeHtml(owner.longName ?? "—")}</dd>
      <dt>Short name</dt><dd>${escapeHtml(owner.shortName ?? "—")}</dd>
      <dt>Licensed</dt><dd>${owner.isLicensed ? "yes" : "no"}</dd>
      <dt>Public key</dt><dd class="mono">${escapeHtml(owner.publicKey ?? snap.config?.security?.publicKey ?? "—")}
        ${owner.publicKey || snap.config?.security?.publicKey ? `<button type="button" data-action="copy-value" data-value="${escapeHtml(owner.publicKey ?? snap.config?.security?.publicKey)}">copy</button>` : ""}</dd>
      <dt>Private key</dt><dd class="mono">
        ${snap.config?.security?.privateKey ? `
          <span>${revealed ? escapeHtml(snap.config.security.privateKey) : "•".repeat(24)}</span>
          <button type="button" data-action="toggle-reveal-read" data-key="privateKey">${revealed ? "hide" : "reveal"}</button>
          <button type="button" data-action="copy-value" data-value="${escapeHtml(snap.config.security.privateKey)}">copy</button>
        ` : '<span class="muted">not exposed by device</span>'}</dd>
      <dt>Fixed position</dt><dd>${snap.config?.position?.fixedPosition
        ? `${(snap.position?.latitudeI ?? 0) * 1e-7}, ${(snap.position?.longitudeI ?? 0) * 1e-7}${snap.position?.altitude != null ? ` @ ${snap.position.altitude}m` : ""}`
        : "not set"}</dd>
    </dl>
    <div class="row-actions">
      <button type="button" data-action="save-local-from-read" data-mode="new">Save as new local profile</button>
      ${boundProfile ? `<button type="button" data-action="save-local-from-read" data-mode="update" data-id="${boundProfile.id}">Update "${escapeHtml(boundProfile.label)}"</button>` : ""}
    </div>
  </div>`;
}

export function onAction(state, action, target) {
  switch (action) {
    case "recapture":
      return { asyncAction: "recapture" };
    case "save-snapshot": {
      if (!state.liveSnapshot) return true;
      const id = state.liveSnapshot.nodeNum != null
        ? (listLocalProfiles(state.store).find((p) => p.boundTo?.nodeNum === state.liveSnapshot.nodeNum)?.id ?? `snap-${Date.now()}`)
        : `snap-${Date.now()}`;
      const defaultLabel = connectionLabel(state.connection) ?? `Snapshot ${formatTimestamp(new Date().toISOString())}`;
      const entered = prompt("Name this snapshot:", defaultLabel);
      if (entered === null) return true; // cancelled
      const label = entered.trim() || defaultLabel;
      state.store.snapshots[id] = { ...state.liveSnapshot, label };
      state.ui.readMessage = `Saved snapshot "${label}" — pick "Another saved snapshot" under Compare against to use it, or rename/delete it from the Data tab.`;
      return true;
    }
    case "set-read-mode":
      state.ui.readMode = target.dataset.mode;
      return true;
    case "set-baseline-mode":
      state.ui.readBaselineMode = target.value;
      state.ui.readBaselineId = null;
      return true;
    case "set-baseline-id":
      state.ui.readBaselineId = target.value || null;
      return true;
    case "toggle-diff-row": {
      const key = target.dataset.key;
      if (state.ui.selectedDiffRows.has(key)) state.ui.selectedDiffRows.delete(key);
      else state.ui.selectedDiffRows.add(key);
      return true;
    }
    case "select-all-diffs": {
      const { allRows } = computeGlobalDiffRows(state);
      for (const row of allRows) state.ui.selectedDiffRows.add(`${row.area}.${row.sectionKey}.${row.fieldPath}`);
      return true;
    }
    case "select-none-diffs":
      state.ui.selectedDiffRows.clear();
      return true;
    case "promote-target-select":
      state.ui.promoteTargetId = target.value;
      return true;
    case "promote-selected": {
      const snap = state.liveSnapshot;
      const { allRows } = computeGlobalDiffRows(state);
      const rows = allRows.filter((row) => state.ui.selectedDiffRows.has(`${row.area}.${row.sectionKey}.${row.fieldPath}`));
      if (rows.length === 0) return true;
      let target_ = state.ui.promoteTargetId && state.ui.promoteTargetId !== "new"
        ? state.store.globalProfiles[state.ui.promoteTargetId]
        : null;
      if (!target_) {
        target_ = newGlobalProfile(`Promoted from device #${snap.nodeNum}`);
        upsertGlobalProfile(state.store, target_);
      }
      promoteRows(target_, rows);
      upsertGlobalProfile(state.store, target_);
      state.ui.selectedDiffRows.clear();
      state.ui.error = null;
      // Keep pointing at the profile just built, so a second round of
      // checking more boxes and promoting again continues the same
      // profile instead of spawning a new one each time.
      state.ui.promoteTargetId = target_.id;
      // Stay on Read -- promoting is often done in several rounds (more
      // fields, maybe from a second reference device) before moving on to
      // Write. Pre-select the profile there anyway, as a convenience for
      // whenever they do switch tabs.
      state.ui.writeGlobalId = target_.id;
      return true;
    }
    case "toggle-reveal-read": {
      const key = `read.${target.dataset.key}`;
      if (state.ui.revealedSecrets.has(key)) state.ui.revealedSecrets.delete(key);
      else state.ui.revealedSecrets.add(key);
      return true;
    }
    case "copy-value":
      navigator.clipboard?.writeText(target.dataset.value).catch(() => {});
      return true;
    case "save-local-from-read": {
      const snap = state.liveSnapshot;
      let profile;
      if (target.dataset.mode === "update") {
        profile = state.store.localProfiles[target.dataset.id];
      }
      if (!profile) {
        profile = newLocalProfile(snap.owner?.longName || `Device #${snap.nodeNum}`);
      }
      profile.owner = {
        longName: snap.owner?.longName ?? "",
        shortName: snap.owner?.shortName ?? "",
        isLicensed: !!snap.owner?.isLicensed,
      };
      if (snap.config?.security?.privateKey) profile.security.privateKey = snap.config.security.privateKey;
      profile.security.publicKey = snap.owner?.publicKey ?? snap.config?.security?.publicKey ?? "";
      profile.boundTo = { nodeNum: snap.nodeNum, bleName: connectionLabel(state.connection), hwModel: snap.hwModel ?? null };
      touch(profile);
      upsertLocalProfile(state.store, profile);
      state.ui.selectedLocalId = profile.id;
      state.route = "local";
      return true;
    }
    default:
      return false;
  }
}
