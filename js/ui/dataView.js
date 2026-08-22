// Data tab: export/import the whole store as JSON, so the fleet
// definition (profiles, keys, snapshots) can be backed up or moved to
// another browser/machine. Also the one place saved snapshots (created
// from Read -> Save snapshot) can be renamed or deleted -- unlike the
// Read tab, this view doesn't require a connected device, so it stays
// reachable to clean up old snapshots at any time.
import { exportJson, importJson, save } from "../storage.js";
import { escapeHtml, formatTimestamp } from "../util.js";

export function render(state) {
  const { store } = state;
  const counts = {
    global: Object.keys(store.globalProfiles).length,
    local: Object.keys(store.localProfiles).length,
    snapshots: Object.keys(store.snapshots).length,
  };
  return `<section class="view data-view">
    <h2>Data</h2>
    <p>Everything MeshFleet knows is stored in this browser's localStorage: ${counts.global} global profile(s),
      ${counts.local} local profile(s), ${counts.snapshots} saved snapshot(s).</p>
    <p class="muted">Private keys are stored unencrypted. Anyone with access to this browser profile or its
      devtools can read them. Treat exported files the same way you'd treat a password backup.</p>
    <div class="row-actions">
      <button type="button" data-action="export-store">Download backup (.json)</button>
      <label class="file-input-label">Restore from backup…
        <input type="file" accept="application/json" data-action="import-store" />
      </label>
      <button type="button" class="danger" data-action="clear-store">Erase all MeshFleet data</button>
    </div>
    ${state.ui.dataMessage ? `<p class="muted">${escapeHtml(state.ui.dataMessage)}</p>` : ""}
    ${renderSnapshotManager(store)}
  </section>`;
}

function renderSnapshotManager(store) {
  const snapshots = Object.entries(store.snapshots)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""));
  if (snapshots.length === 0) return "";

  const rows = snapshots.map((s) => `<tr>
    <td><input type="text" data-action="rename-snapshot" data-id="${s.id}" value="${escapeHtml(s.label ?? s.id)}" /></td>
    <td>${formatTimestamp(s.capturedAt)}</td>
    <td><button type="button" class="danger" data-action="delete-snapshot" data-id="${s.id}">Delete</button></td>
  </tr>`).join("");

  return `<div class="profile-summary">
    <h3>Saved snapshots</h3>
    <table class="diff-table">
      <thead><tr><th>Name</th><th>Captured</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function onAction(state, action, target, event) {
  switch (action) {
    case "export-store": {
      const blob = new Blob([exportJson(state.store)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `meshfleet-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    }
    case "import-store": {
      const file = target.files?.[0];
      if (!file) return true;
      file.text().then((text) => {
        try {
          const imported = importJson(text);
          state.store = imported;
          save(state.store);
          state.ui.dataMessage = `Imported backup from ${file.name}.`;
        } catch (err) {
          state.ui.error = `Import failed: ${err.message}`;
        }
        state.render();
      });
      return true;
    }
    case "clear-store": {
      if (!confirm("Erase all MeshFleet data (profiles, keys, snapshots) from this browser? This cannot be undone.")) return true;
      state.store = { version: 1, globalProfiles: {}, localProfiles: {}, snapshots: {}, settings: { lastGlobalProfileId: null, lastLocalProfileId: null, rebootWaitMs: 8000 } };
      save(state.store);
      state.ui.dataMessage = "All data erased.";
      return true;
    }
    case "rename-snapshot": {
      const snap = state.store.snapshots[target.dataset.id];
      if (!snap) return true;
      snap.label = target.value.trim() || snap.label;
      return true;
    }
    case "delete-snapshot": {
      const id = target.dataset.id;
      const snap = state.store.snapshots[id];
      if (!snap) return true;
      if (!confirm(`Delete snapshot "${snap.label ?? id}"? This cannot be undone.`)) return true;
      delete state.store.snapshots[id];
      if (state.ui.readBaselineId === id) state.ui.readBaselineId = null;
      return true;
    }
    default:
      return false;
  }
}
