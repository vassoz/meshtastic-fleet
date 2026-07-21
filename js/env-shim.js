// Classic (non-module) script, intentionally loaded BEFORE the
// <script type="module"> tag in index.html.
//
// @meshtastic/core bundles tslog, which references the bare identifier
// `process` (e.g. `process?.version`, `process.cwd()`) when building log
// metadata. Optional chaining only guards against a null/undefined
// *value* -- it does nothing for an identifier that was never declared,
// so in a browser (no Node `process` global) that access throws
// `ReferenceError: process is not defined` the moment the bundle runs.
//
// Module scripts execute after all preceding classic scripts, so this
// shim is guaranteed to be in place before any vendored module imports it.
(function () {
  if (typeof globalThis.process === "undefined") {
    globalThis.process = {
      env: {},
      version: "",
      versions: {},
      platform: "browser",
      cwd: function () {
        return "/";
      },
      nextTick: function (fn) {
        Promise.resolve().then(fn);
      },
      argv: [],
    };
  }

  // Same story for `Buffer`: tslog's internal `isBuffer(arg)` helper calls
  // `Buffer.isBuffer(arg)` unconditionally (bundled into core's mod.js,
  // one call site, used while masking log payload objects -- e.g. every
  // MeshDevice.configure()/sendText()/etc. debug log). Meshtastic's own
  // data never uses Node Buffers (protobuf bytes fields are Uint8Array),
  // so "always false" isn't just a safe stub here, it's the correct
  // answer too -- nothing in this app ever constructs a real Buffer.
  if (typeof globalThis.Buffer === "undefined") {
    globalThis.Buffer = {
      isBuffer: function () {
        return false;
      },
    };
  }
})();
