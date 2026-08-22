# MeshFleet

A local, zero-build web app for provisioning a fleet of Meshtastic devices
(built for 6× SenseCAP Card Tracker T1000-E) over Web Bluetooth or USB
(Web Serial). It splits configuration into two axes:

- **Global profiles** — fleet-wide policy: channels + PSKs, LoRa region/
  preset, GPS/position behaviour, telemetry intervals, security policy.
  Built **only** by reading a reference device and selecting which fields
  to keep — there's no form to hand-author one. Configure a single device
  however you like (factory app, physical buttons, whatever), read it,
  tick the fields worth propagating, and that becomes a reusable profile
  to write to the rest of the fleet.
- **Local profiles** — per-device identity: long/short name, PKI private
  key, optional fixed position, optional BLE fixed PIN. One per physical
  unit, edited directly (each device's name/key is inherently unique, so
  this one *is* a small form).

**Read** pulls a device's live state and diffs it against firmware
defaults, a saved global profile, or another saved snapshot, so you can
see exactly what differs and choose what to promote into a fleet profile.
**Write** merges a chosen global + local profile, diffs the result against
a *fresh* read of the connected device, previews the exact fields that
will change, and writes only those — as a single begin/commit transaction
(one flash save, one reboot), then reconnects and verifies. Unchecked
fields are never touched, on read or on write.

Everything lives in this browser's `localStorage`. There's no server and
nothing leaves your machine.

## Requirements

- **Chrome or Edge**, desktop or Android, for the **Bluetooth** connection.
  Neither Firefox nor Safari implements Web Bluetooth — the app will tell
  you if it's missing.
- **Chrome or Edge on desktop** for the **USB** connection. Web Serial is
  desktop-Chromium-only — not implemented on Android Chrome, Firefox, or
  Safari. USB also sidesteps Bluetooth pairing entirely, which is
  particularly handy right after a factory reset (see below).
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

The very first connection to a given device is also just slower and
flakier than every connection after it: the OS has to do its own
Bluetooth *bonding* handshake (the PIN prompt is part of that), and the
GATT link stays unstable the whole time that system dialog is sitting
there unanswered. **Watch for a pairing/PIN confirmation popup from your
phone or computer's OS** (not the browser) and accept it — the app
retries for a good while specifically to ride this out, and once a
device is bonded, every connection after the first is fast.

Once you've built a global profile that manages `bluetooth.mode`/
`bluetooth.fixedPin` (see Workflow below — set those two on your
reference device however you configured it, then read+promote them like
anything else), writing it to the rest of the fleet gives every unit the
same known PIN, and you won't hit this again.

Or skip Bluetooth pairing for this device entirely: **Connect via USB…**
(top right) has none of the above — no OS-level bonding, no PIN, and it's
the more reliable connection for the DFU/firmware-flash buttons on the
Write tab too (see Workflow below).

## Workflow

Typical loop, once per fleet-wide setting you care about:

1. Factory-reset or reflash a device, then configure it however you like
   — the stock Meshtastic app, physical buttons, a serial CLI, whatever's
   convenient. This is your **reference device**; MeshFleet never
   hand-authors config, it only replicates what it reads.
2. Connect that device (top right) and go to **Read** → *Global config
   diff*. It's diffed against firmware defaults (or a saved profile, or
   another saved snapshot — pick from the dropdown) so you see exactly
   what's non-default. Tick the fields worth keeping — channels, LoRa
   region, GPS intervals, whatever you actually changed — and hit
   **Promote selected**, into a new or existing profile. Repeat across
   several read sessions if you're pulling settings together from more
   than one reference; promoting again reuses the same profile instead of
   spawning a new one.
3. **Local** — one profile per physical unit: names, private key
   (generate a fresh X25519 key or paste one — e.g. one you just read off
   a device before wiping it), optional fixed position, optional BLE
   fixed PIN. This is the one thing that's still a hand-edited form,
   since every device's identity is inherently unique.
4. **Fleet** lists your local profiles as device slots — bind the
   currently-connected device to one, see its last-read timestamp, and
   jump to editing it.
5. **Write** — connect the next device, pick the global + local profile,
   **Build plan** (always diffed against a fresh read of *this* device,
   never a stale snapshot), review exactly what will change, confirm. The
   device reboots once; the app reconnects automatically and reports
   which fields verified successfully. The Write tab is also where you
   rename or delete a global profile — there's no separate editor, just a
   read-only list of what it manages.
6. **Enter DFU mode / flash firmware** — also at the bottom of the Write
   tab, two buttons put the device into its bootloader for a firmware
   flash: **Enter DFU mode…** sends Meshtastic's own admin command
   (works on most hardware), and **Force DFU via USB (1200bps reset)…**
   (only shown when connected over USB) does a low-level "1200bps touch"
   reset instead — the same mechanism Meshtastic's own upload tooling
   (`nrfutil`) uses, and more reliable on hardware/firmware combinations
   where the admin command just reboots the device back into the app
   instead of the bootloader (confirmed on some T1000-E units). If
   neither works, the physical fallback is to hold the device's button
   and plug in the USB cable twice in quick succession — the green LED
   goes solid when it's worked. Either way, once in DFU mode a removable
   drive (e.g. `T1000-E-BOOT`) appears for dragging a `.uf2` firmware
   file onto.
7. **Factory reset** — also at the bottom of the Write tab (only shown
   while connected), a **Factory reset…** button erases the device's
   config, channels, PKI keys and node data entirely (the firmware
   disables Bluetooth and reboots immediately after, same as a fresh
   flash) — asks for confirmation first, and the confirmation reminds
   you to capture the device's private key via Read → Local identity
   first if you haven't, since it can't be recovered afterward. Erasing
   the device's own Bluetooth bonding keys along with everything else
   leaves your OS holding a now-stale pairing, so reconnecting afterward
   typically fails until you remove/forget the device in your OS's
   Bluetooth settings and re-pair from scratch — MeshFleet can't do this
   itself (Web Bluetooth has no permission to touch OS-level pairings).
   On Windows, `tools/windows-unpair-bluetooth.ps1` does the removal from
   the command line; run it once with no arguments to preview what it'd
   remove, then again with `-Remove`. Or just reconnect over **USB**
   instead — it has no OS-level pairing to go stale in the first place.
8. **Data** — export/import the whole store as JSON for backup, or to
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
  conn.js                Bluetooth + USB serial connect/reconnect
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

`@meshtastic/core@2.6.7`, `@meshtastic/transport-web-bluetooth@0.1.5`, and
`@meshtastic/transport-web-serial@0.2.5` (the latest versions published to
npm at the time this was built) bundle `@meshtastic/protobufs` at a
specific version. If your device's firmware is newer and has added fields
to a config section, those specific new fields won't have editable UI
here (older/unknown fields elsewhere still round-trip fine). Fix: bump
the pinned protobufs dependency and re-vendor.
