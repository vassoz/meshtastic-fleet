# MeshFleet

A local, zero-build web app for provisioning a fleet of Meshtastic devices
(built for 6× SenseCAP Card Tracker T1000-E) over Web Bluetooth. It splits
configuration into two axes:

- **Global profiles** — fleet-wide policy: channels + PSKs, LoRa region/
  preset, GPS/position behaviour, telemetry intervals, security policy.
  Author once, write to every unit.
- **Local profiles** — per-device identity: long/short name, PKI private
  key, optional fixed position, optional BLE fixed PIN. One per physical
  unit.

**Read** pulls a device's live state and diffs it against firmware
defaults, a saved global profile, or another saved snapshot, so you can
see exactly what differs and choose what to promote into a fleet profile.
**Write** merges a chosen global + local profile, diffs the result against
a *fresh* read of the connected device, previews the exact fields that
will change, and writes only those — as a single begin/commit transaction
(one flash save, one reboot), then reconnects and verifies.

Everything lives in this browser's `localStorage`. There's no server and
nothing leaves your machine.

## Requirements

- **Chrome or Edge**, desktop or Android. Web Bluetooth isn't implemented
  in Firefox or Safari — the app will tell you if it's missing.
- **Python 3** (only used to vendor dependencies once and to serve static
  files — no Node/npm needed, no build step).

## Setup

```sh
python3 tools/vendor.py   # downloads the pinned dependency versions into vendor/ (run once)
./serve.sh                # http://localhost:8080
```

Open `http://localhost:8080` in Chrome or Edge. `localhost` counts as a
secure context, so Web Bluetooth works without HTTPS.

To pick up a newer release of a dependency, edit `PINNED_VERSIONS` at the
top of `tools/vendor.py` and re-run it — it's idempotent and safe to
re-run any time. Afterward, open `http://localhost:8080/tools/vendor-check.html`
— it exercises `MeshDevice` against a mock transport (no hardware needed)
and should show three PASS lines. This catches environment gaps in the
vendored bundle before you find them the hard way against real hardware —
it's exactly how two early bugs were found: `@meshtastic/core`'s bundled
logger throws on *every* debug/info log call (i.e. on every device
interaction) if the vendored `util` polyfill's `util.types.*` predicates
aren't implemented, and it references the bare `Buffer` global directly.
Both are patched in `tools/vendor.py` / `js/env-shim.js` respectively, but
a version bump could introduce a similar new gap.

## First connection to a T1000-E

The T1000-E has no screen, so it can't show you a random Bluetooth
pairing PIN. Two ways around that:

1. **Try `123456`** — some firmware versions default to a fixed PIN.
2. If that fails, connect the device over **USB serial** once (any serial
   terminal at 115200 baud) and read the PIN the firmware prints on
   boot/pairing.

Once connected, the easiest fix is to write a global profile that sets
**Bluetooth mode → Fixed PIN** (Global → Advanced → Bluetooth) with a PIN
of your choosing early on — after that, every device in the fleet re-pairs
with the same known PIN, and you won't hit this again.

## Workflow

1. **Global** — build one or more fleet-wide profiles. Curated tabs cover
   Channels, Position/GPS, LoRa, Device, and Security; **Advanced** covers
   every other `Config`/`ModuleConfig` section, generated directly from
   the protobuf schema bundled in `@meshtastic/core` — so it's never
   missing a field, even ones this README doesn't mention. Every field has
   its own "manage this field" checkbox: unchecked fields are left alone
   on the device.
2. **Local** — one profile per physical unit: names, private key
   (generate a fresh X25519 key or paste an existing one — e.g. one you
   just read off the device), optional fixed position, optional BLE fixed
   PIN.
3. Connect a device (top right), then **Read** it:
   - *Global config diff* shows every field that differs from your chosen
     baseline (firmware defaults / a saved profile / another saved
     snapshot), with checkboxes to promote selected values into a global
     profile.
   - *Local identity* shows names, hardware model, firmware version, and
     the device's keys (masked; click reveal/copy) — "Save as local
     profile" captures all of it in one click.
4. **Fleet** lists your local profiles as device slots — bind the
   currently-connected device to one, see its last-read timestamp, and
   jump to editing it.
5. **Write** — pick a global + local profile, **Build plan** (this always
   diffs against a fresh read of the connected device, never a stale
   snapshot), review exactly what will change, confirm. The device
   reboots once; the app reconnects automatically and reports which
   fields verified successfully.
6. **Factory reset** — while connected, the top-right connection indicator
   has a **Factory reset…** button next to Disconnect. It erases the
   device's config, channels, PKI keys and node data entirely (the
   firmware disables Bluetooth and reboots immediately after, same as a
   fresh flash) — asks for confirmation first, and the confirmation
   reminds you to capture the device's private key via Read → Local
   identity first if you haven't, since it can't be recovered afterward.
7. **Data** — export/import the whole store as JSON for backup, or to
   move your fleet setup to another machine/browser.

## Why writes are read-modify-write

Meshtastic's firmware replaces an entire `Config`/`ModuleConfig`/`Channel`
section wholesale on write (confirmed by reading `AdminModule.cpp`:
`config.position = c.payload_variant.position;`, same pattern for every
other section) — there is no field-level merge on the device side. So
"only send the fields I want to change" would silently reset every
*other* field in that section back to its firmware default.

`writer.js` avoids this by always building the outgoing message as *the
device's current section (from a fresh read) with only the managed fields
overlaid on top* — never the managed fields alone. `setOwner` is the one
exception: the firmware merges that field-by-field
(`if (*o.long_name) { ...set... }`), so names are sent directly.

## Security notes

- Private keys are stored **unencrypted** in this browser's
  `localStorage`. Anyone with access to this browser profile or its
  devtools can read them. Exported backup files are the same — handle
  them like a password backup.
- The app never writes a device's derived public key — only the private
  key. The firmware always recomputes the matching public key on write.

## Project layout

```
index.html            import map + app shell
serve.sh               python3 -m http.server 8080
tools/vendor.py        one-shot dependency vendoring (re-runnable)
js/
  main.js               composition root: app state, rendering, event wiring
  conn.js                Web Bluetooth connect/reconnect
  snapshot.js             configure() -> full DeviceSnapshot capture
  schema.js               protobuf descriptor reflection helpers
  defaults.js              firmware zero-value baseline + a few annotated defaults
  diff.js                 structural JSON diffing
  profiles.js              global/local profile CRUD + managed-field bookkeeping
  writer.js                write plan builder + transaction executor + verify
  keys.js                  X25519 key generation
  storage.js               localStorage persistence + export/import
  util.js                  small shared helpers
  ui/                      one render()/onAction() module per tab
vendor/                 dependency closure fetched by tools/vendor.py (checked in)
```

## Pinned versions / known limitation

`@meshtastic/core@2.6.7` and `@meshtastic/transport-web-bluetooth@0.1.5`
(the latest versions published to npm at the time this was built) bundle
`@meshtastic/protobufs` at a specific version. If your device's firmware
is newer and has added fields to a config section, those specific new
fields won't have editable UI here (older/unknown fields elsewhere still
round-trip fine). Fix: bump the pinned protobufs dependency and re-vendor.
