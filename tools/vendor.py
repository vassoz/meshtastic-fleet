#!/usr/bin/env python3
"""
Vendors MeshFleet's JS dependencies into ../vendor/ so the app runs with
zero build step (plain <script type="module"> + an import map).

Idempotent: safe to re-run. Re-run after bumping a PINNED_VERSIONS entry
to pull a newer release.

Sources:
  - npm tarballs for @meshtastic/core, @meshtastic/transport-web-bluetooth,
    @meshtastic/transport-web-serial, @bufbuild/protobuf, crc  (downloaded
    straight from registry.npmjs.org, no npm/node required)
  - esm.sh's `unenv` browser polyfills for the three bare Node builtins
    (os, path, util) that @meshtastic/core's published bundle imports.
    Only 6 files / ~15 KB are needed for os+path+util; verified by
    resolving the transitive import graph by hand (see README.md).

Usage:  python3 tools/vendor.py
"""
from __future__ import annotations

import io
import json
import posixpath
import re
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

PINNED_VERSIONS = {
    "@meshtastic/core": "2.6.7",
    "@meshtastic/transport-web-bluetooth": "0.1.5",
    "@meshtastic/transport-web-serial": "0.2.5",
    "@bufbuild/protobuf": "2.12.1",
    "crc": "4.3.2",
}

ESM_SH_BASE = "https://esm.sh"
NODE_POLYFILL_ENTRYPOINTS = ["/node/os.mjs", "/node/path.mjs", "/node/util.mjs"]


def log(msg: str) -> None:
    print(f"[vendor] {msg}")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read()


def npm_tarball_url(pkg: str, version: str) -> str:
    # Scoped packages (@scope/name) keep the scope in the tarball filename
    # after the last "/", e.g. @meshtastic/core -> core-2.6.7.tgz
    name = pkg.split("/")[-1]
    return f"https://registry.npmjs.org/{pkg}/-/{name}-{version}.tgz"


def download_npm_package(pkg: str, version: str) -> tarfile.TarFile:
    log(f"downloading {pkg}@{version} ...")
    data = fetch(npm_tarball_url(pkg, version))
    return tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")


def extract_matching(tf: tarfile.TarFile, prefix: str, dest: Path, *, suffix: str = ".js") -> list[Path]:
    """Extract every file under package/<prefix> ending in `suffix` into dest,
    preserving the path structure relative to <prefix>."""
    dest.mkdir(parents=True, exist_ok=True)
    written = []
    full_prefix = f"package/{prefix}"
    for member in tf.getmembers():
        if not member.isfile():
            continue
        if not member.name.startswith(full_prefix):
            continue
        if suffix and not member.name.endswith(suffix):
            continue
        rel = member.name[len(full_prefix):].lstrip("/")
        out_path = dest / rel
        out_path.parent.mkdir(parents=True, exist_ok=True)
        f = tf.extractfile(member)
        if f is None:
            continue
        out_path.write_bytes(f.read())
        written.append(out_path)
    return written


def vendor_meshtastic_core() -> None:
    version = PINNED_VERSIONS["@meshtastic/core"]
    tf = download_npm_package("@meshtastic/core", version)
    dest = VENDOR / "meshtastic-core"
    files = extract_matching(tf, "dist/", dest)
    log(f"  -> {len(files)} file(s) in {dest.relative_to(ROOT)}")


def vendor_transport_web_bluetooth() -> None:
    version = PINNED_VERSIONS["@meshtastic/transport-web-bluetooth"]
    tf = download_npm_package("@meshtastic/transport-web-bluetooth", version)
    dest = VENDOR / "meshtastic-transport-web-bluetooth"
    files = extract_matching(tf, "dist/", dest)
    log(f"  -> {len(files)} file(s) in {dest.relative_to(ROOT)}")


def vendor_transport_web_serial() -> None:
    version = PINNED_VERSIONS["@meshtastic/transport-web-serial"]
    tf = download_npm_package("@meshtastic/transport-web-serial", version)
    dest = VENDOR / "meshtastic-transport-web-serial"
    files = extract_matching(tf, "dist/", dest)
    log(f"  -> {len(files)} file(s) in {dest.relative_to(ROOT)}")


def vendor_bufbuild_protobuf() -> None:
    version = PINNED_VERSIONS["@bufbuild/protobuf"]
    tf = download_npm_package("@bufbuild/protobuf", version)
    dest = VENDOR / "bufbuild-protobuf"
    files = extract_matching(tf, "dist/esm/", dest)
    log(f"  -> {len(files)} file(s) in {dest.relative_to(ROOT)}")


def vendor_crc() -> None:
    # Only @meshtastic/core's crc16ccitt calculator is used, and it's a
    # single self-contained ESM file (no further imports) -- extract it
    # directly rather than mirroring the whole `crc` package.
    version = PINNED_VERSIONS["crc"]
    tf = download_npm_package("crc", version)
    dest = VENDOR / "crc" / "calculators"
    dest.mkdir(parents=True, exist_ok=True)
    member = tf.getmember("package/mjs/calculators/crc16ccitt.js")
    f = tf.extractfile(member)
    assert f is not None
    (dest / "crc16ccitt.js").write_bytes(f.read())
    log(f"  -> 1 file(s) in {(dest / 'crc16ccitt.js').relative_to(ROOT)}")


IMPORT_RE = re.compile(r'((?:from|import)\s*)"([^"]+)"')

# esm.sh serves these Node builtins via `unenv`, which stubs out the long
# tail of rarely-used APIs as functions that *throw* "not implemented yet"
# the moment they're called (util.mjs, util/types.mjs, os.mjs and path.mjs's
# chunk all define the same private `stub(name) => () => { throw ... }`
# factory, just under different local variable names). That's a real
# landmine: @meshtastic/core's bundled tslog logger calls util.types.*
# (isNativeError, isTypedArray, ...) while formatting *any* debug/info log
# line with an object argument -- e.g. every MeshDevice.configure() call --
# so an unrelated, rarely-hit stub like isNativeError being unimplemented
# reliably crashes real device reads, not just an edge case.
#
# Patch the stub factory itself, structurally (works regardless of which
# local variable names esm.sh's minifier picked), so an unimplemented call
# degrades to a console.warn + a safe return value (`false` for anything
# that looks like an `is*` predicate, `undefined` otherwise) instead of
# throwing. Confirmed to match exactly once in each of util.mjs,
# util/types.mjs, os.mjs and path.mjs's chunk-*.mjs.
STUB_FACTORY_RE = re.compile(
    r"function (\w+)\((\w+)\)\{return Object\.assign\(\(\)=>\{throw (\w+)\(\2\)\},\{__unenv__:!0\}\)\}"
)


def patch_unimplemented_stubs(text: str) -> str:
    def repl(m: re.Match) -> str:
        stub_fn, param, _gen_fn = m.group(1), m.group(2), m.group(3)
        return (
            f'function {stub_fn}({param}){{return Object.assign((...a)=>'
            f'{{console.warn("[meshfleet] unimplemented Node API called:",{param},a);'
            f'return /\\.is[A-Z]/.test({param})?false:void 0}},{{__unenv__:!0}})}}'
        )

    return STUB_FACTORY_RE.sub(repl, text)


def vendor_node_polyfills() -> None:
    """Resolve the transitive import graph of the unenv os/path/util shims
    esm.sh serves at /node/*.mjs, download them, and rewrite every
    "/node/..." absolute specifier to a relative one so the files work when
    served from vendor/node/ with no rewriting proxy in front of them."""
    log("resolving esm.sh node polyfill closure (os, path, util) ...")
    sources: dict[str, str] = {}
    todo = list(NODE_POLYFILL_ENTRYPOINTS)
    seen: set[str] = set()
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        text = fetch(ESM_SH_BASE + p).decode("utf-8")
        sources[p] = text
        directory = posixpath.dirname(p)
        for _, spec in IMPORT_RE.findall(text):
            if spec.startswith("/node/"):
                todo.append(spec)
            elif spec.startswith("."):
                todo.append(posixpath.normpath(posixpath.join(directory, spec)))
            else:
                raise RuntimeError(f"unexpected bare import {spec!r} in {p}; "
                                    f"the vendored node polyfill set is no longer self-contained")

    dest = VENDOR / "node"
    dest.mkdir(parents=True, exist_ok=True)
    patched_count = 0
    for p, text in sources.items():
        rel = p[len("/node/"):]  # e.g. "os.mjs" or "util/types.mjs"
        out_path = dest / rel
        out_dir = posixpath.dirname(rel)

        def rewrite(m: re.Match) -> str:
            keyword, spec = m.group(1), m.group(2)
            if not spec.startswith("/node/"):
                return m.group(0)
            target_rel = spec[len("/node/"):]
            rel_path = posixpath.relpath(target_rel, out_dir) if out_dir else "./" + target_rel
            if not rel_path.startswith("."):
                rel_path = "./" + rel_path
            return f'{keyword}"{rel_path}"'

        rewritten = IMPORT_RE.sub(rewrite, text)
        patched = patch_unimplemented_stubs(rewritten)
        if patched != rewritten:
            patched_count += 1
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(patched, encoding="utf-8")
    log(f"  -> {len(sources)} file(s) in {dest.relative_to(ROOT)} ({patched_count} had unimplemented-stub guards applied)")


def write_manifest() -> None:
    manifest = {
        "generatedBy": "tools/vendor.py",
        "pinnedVersions": PINNED_VERSIONS,
        "files": sorted(
            str(p.relative_to(VENDOR))
            for p in VENDOR.rglob("*")
            if p.is_file() and p.name != "MANIFEST.json"
        ),
    }
    (VENDOR / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {(VENDOR / 'MANIFEST.json').relative_to(ROOT)} "
        f"({len(manifest['files'])} files tracked)")


def main() -> None:
    VENDOR.mkdir(exist_ok=True)
    vendor_meshtastic_core()
    vendor_transport_web_bluetooth()
    vendor_transport_web_serial()
    vendor_bufbuild_protobuf()
    vendor_crc()
    vendor_node_polyfills()
    write_manifest()
    log("done.")


if __name__ == "__main__":
    main()
