# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MeshFleet: a zero-build, client-only web app for provisioning a fleet of
Meshtastic devices (built for 6× SenseCAP Card Tracker T1000-E) over Web
Bluetooth. No framework, no bundler, no server-side component — plain
ES modules loaded via an import map, served as static files. Everything
persists in the browser's `localStorage`; nothing leaves the machine.

Deployed via GitHub Pages on every push to `main` (`.github/workflows/deploy-pages.yml`).

## Commands

```sh
python3 tools/vendor.py   # fetch pinned third-party deps into vendor/ (gitignored, run once, idempotent)
./serve.sh                # python3 -m http.server 8080 -- http://localhost:8080
./serve.sh 9000            # optional port arg
```

There is no build step, no test runner, no linter, and no package.json —
`vendor/` is fetched directly from npm tarballs/esm.sh by `tools/vendor.py`,
not installed via npm/node.

To verify the vendored bundle works without real hardware, open
`http://localhost:8080/tools/vendor-check.html` after vendoring — it
exercises `MeshDevice` against a mock transport and should print three
PASS lines. Run this after bumping any pinned dependency version; it's
how two real bugs were caught before real-hardware testing (see
"Vendoring gotchas" below).

There are no automated tests beyond `tools/vendor-check.html`. Manual
verification against real hardware (or at least the mock-transport check)
is the only way to validate a change that touches `conn.js`, `snapshot.js`,
or `writer.js`.

## Architecture

### Two-axis profile model (the core domain concept)

Config is split across two independent profile types, combined only at
write time:

- **Global profile** (`js/profiles.js`) — fleet-wide policy (channels/PSKs,
  LoRa region, GPS/position behavior, telemetry intervals...). Sparse *by
  field*: it stores a flat `managedPaths` list of fully-qualified leaf
  paths (e.g. `"config.position.gpsUpdateInterval"`, `"channels.0.settings.name"`)
  plus a `data` tree holding only those values. There is deliberately no
  form to hand-author one — it's built only by reading a reference device
  (Read tab) and promoting selected diff rows (`promoteRows`).
- **Local profile** — per-device identity (long/short name, PKI private
  key, optional fixed position, optional BLE fixed PIN). One per physical
  unit, hand-edited directly since each device's identity is inherently
  unique.

### Why writes are read-modify-write (critical invariant)

The Meshtastic firmware replaces an entire `Config`/`ModuleConfig`/`Channel`
section **wholesale** on write (confirmed by reading `AdminModule.cpp`,
e.g. `config.position = c.payload_variant.position;`) — there is no
field-level merge on the device side. So sending "only the fields I want
to change" would silently reset every *other* field in that section to
its firmware default.

`writer.js`'s `buildWritePlan()` therefore always builds the outgoing
message as *the device's current section (from a fresh read) with only
the managed fields overlaid on top* (`overlayPaths` in `util.js`) — never
the managed fields alone. `setOwner` and the fixed-position admin calls
are the exceptions: the firmware handles those field-by-field or narrowly,
so they're sent directly with no read-modify-write step. Any change to
how config sections are written must preserve this distinction.

Writes execute as one begin/commit transaction
(`device.beginEditSettings()` … `commitEditSettings()`) — a single flash
save and a single reboot — then the app reconnects and calls
`verifyWritePlan()` against a fresh post-write read.

### Data flow through the app

```
conn.js          Web Bluetooth connect/reconnect, holds the BluetoothDevice reference
snapshot.js      configure() -> subscribes to MeshDevice's event streams -> one DeviceSnapshot
schema.js        reflects over @meshtastic/core's bundled protobuf descriptors
                 (enumerates Config/ModuleConfig sections from the schema itself,
                 so a firmware/protobuf bump adding a section needs no code change)
defaults.js      zero-value protobuf baseline (= factory defaults) + a few annotated
                 non-zero firmware defaults, for the Read-tab diff view
diff.js          structural JSON diff (proto3 JSON is already sparse-by-default,
                 so diffing "vs defaults" and "vs a saved profile" is the same operation)
profiles.js      global/local profile CRUD + managedPaths bookkeeping
writer.js        buildWritePlan() (merge + diff vs fresh read) -> executeWritePlan()
                 (transaction) -> verifyWritePlan() (post-write check)
storage.js       localStorage persistence + JSON export/import; STORAGE_KEY = "meshfleet.v1"
keys.js          X25519 keypair generation (PKCS8 export, sliced to the raw 32-byte scalar --
                 WebCrypto's X25519 has no raw private-key export)
```

`snapshot.js`'s `captureSnapshot()` is the one place all device state comes
from: `device.configure()` triggers a single continuous stream of
`FromRadio` packets (every Config section, every ModuleConfig section,
every channel, the node database, then a config-complete marker) and this
is where every subscription needed to assemble a `DeviceSnapshot` is set
up *before* calling `configure()`. `config.security` (including the
private key) is included unredacted in this stream.

### UI layer: no framework, full re-render

`js/main.js` is the composition root — single mutable `state` object, one
`renderApp()` that does `appEl.innerHTML = shell.renderHeader(state) + view.render(state)`
on every change, no virtual DOM. Each tab is a module under `js/ui/`
exporting `render(state) -> HTML string` and `onAction(state, action, target, event) -> true|false|{asyncAction}`:

- Routing table (`routeModules` in `main.js`): `fleet`, `local`, `read`,
  `write`, `data`, each mapped to its `js/ui/*.js` module.
- `dispatch()` tries `shell.onAction()` first (tab-independent chrome:
  nav, connect/disconnect, dismiss-error), then the active view's
  `onAction()` if shell returns `false`.
- Returning `true` from `onAction` triggers a synchronous re-render.
  Returning `{ asyncAction: "name" }` hands off to `runAsyncAction()` in
  `main.js`, which owns re-rendering itself (for BLE operations, key
  generation, writes, factory reset).
- Every `onAction`/async handler call is wrapped in try/catch at the
  dispatch layer — a thrown error becomes `state.ui.error` and still
  re-renders, rather than silently aborting (this was a real bug once:
  an uncaught throw in `buildWritePlan()` made a button look like it did
  nothing).
- Text/number/select/textarea/checkbox inputs are read on the `change`
  event, not `input`/`keydown` — so a full `innerHTML` re-render never
  fights an in-progress keystroke or steals focus mid-type. `SELECT`/`TEXTAREA`
  are change-only; other inputs also get a `click` listener for buttons.

### Connection lifecycle nuances (read before touching `conn.js`/`main.js`)

- `state.connectionStatus` transitions through `disconnected -> connecting
  -> configuring -> connected` (or `-> reconnecting` after a write-induced
  reboot). Any handler that touches the BLE link is wrapped in
  `withTerminalConnectionStatus()` so a thrown error still resolves to a
  definite connected/disconnected status rather than leaving the header
  stuck on "…" forever.
- `watchConnection()` subscribes to `onDeviceStatus` for the *whole
  lifetime* of a connection (not just one read) to catch a silent
  mid-session GATT drop. It intentionally stays quiet whenever
  `state.ui.busy` is true, because the identical `DeviceDisconnected`
  status also fires on a deliberate disconnect and carries no
  distinguishing payload — every handler that intentionally tears down a
  connection is expected to set `busy` first and report its own outcome.
- First-ever connection to a fresh device is slow/flaky (OS-level
  Bluetooth bonding + PIN prompt) — `captureWithRetry()` in `main.js`
  retries up to `CONFIGURE_MAX_ATTEMPTS` (10) with real patience
  (`CONFIGURE_RETRY_DELAY_MS`), not a quick-fail. Don't shrink these
  budgets without understanding why they're that large (see comments in
  `main.js` and the README's "First connection to a T1000-E" section).

### Vendoring gotchas (only relevant when touching `tools/vendor.py` / bumping pinned versions)

- `@meshtastic/core` bundles a logger (`tslog`) that references the bare
  Node globals `process` and `Buffer` unconditionally — `js/env-shim.js`
  (a classic script, loaded before the `type="module"` entrypoint so it's
  guaranteed to run first) stubs both.
- The esm.sh-served Node polyfills (`os`/`path`/`util`, vendored under
  `vendor/node/`) stub out most rarely-used APIs as functions that
  *throw*. `util.types.*` predicates are called on every debug/info log
  line the bundled logger emits (i.e. on every device interaction), so
  `tools/vendor.py`'s `patch_unimplemented_stubs()` rewrites that stub
  factory to warn-and-return-a-safe-value instead of throwing. A version
  bump of any pinned dependency could introduce a similar new gap —
  always re-run `tools/vendor-check.html` after bumping.
- `vendor/` is gitignored and regenerated by CI on every deploy
  (`tools/vendor.py`) — never hand-edit files under it; fix the vendoring
  script instead.

## Security notes (relevant to any change touching profiles/storage)

- Private keys (`config.security.privateKey`) are stored **unencrypted**
  in `localStorage` and in exported JSON backups. This is a known,
  accepted tradeoff for a local-only tool, not an oversight — don't
  "fix" it by adding partial redaction without discussing the tradeoff
  first (redaction would break the export/import round-trip and the
  Read-tab diff).
- The app never writes a device's derived public key, only the private
  key — the firmware always recomputes the public key on write.
