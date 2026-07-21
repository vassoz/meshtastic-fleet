// Data tab: export/import the whole store as JSON, so the fleet
// definition (profiles, keys, snapshots) can be backed up or moved to
// another browser/machine.
import { exportJson, importJson, save } from "../storage.js";
import { escapeHtml } from "../util.js";

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
  </section>`;
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
    default:
      return false;
  }
}
