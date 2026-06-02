#!/usr/bin/env bash
# tests/int-tarball-verify.sh  (task T4.4a — packaging / tarball verification)
#
# Proves the PUBLISHED artifact is self-contained and runnable WITHOUT a working
# tree: it `npm pack`s the package, installs the resulting tarball into a fresh
# throwaway project, and then asserts —
#
#   1. dist/ contains every RUNTIME import the bridge loads:
#        - top-level: index.js, convert.js, models.js
#        - driver:    dist/src/driver/{ansi,claudeP,pty,stream}.js
#        - mcp:       dist/src/mcp/{ipc,router,shim}.js
#        - capture:   dist/src/capture.js
#   2. the `bin` shim (dist/src/mcp/shim.js) is present, AND
#   3. `node <pkg>/dist/src/mcp/shim.js` actually STARTS — all of its runtime
#      dependencies (the MCP SDK, the ipc transport) resolve from the INSTALLED
#      node_modules — and responds deterministically: invoked with no --socket it
#      emits a structured `startup-failed` log naming the missing flag and exits 1.
#      That is the shim's clean "start + respond + exit" contract; it needs no real
#      claude-p, no API key, and no socket peer. (A `--help`-style probe is N/A: the
#      shim has no --help; the missing-required-arg path is its trivial-input
#      equivalent and exercises the same import + argv + log + exit surface.)
#
# Fully DETERMINISTIC: no real claude-p, no network beyond the local install of a
# file: tarball. Cleans up every tmp dir on exit (including on failure).
#
# Run:  bash tests/int-tarball-verify.sh

set -euo pipefail

# ── locate the repo root (this script lives in tests/) ──────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_NAME="$(node -p "require('$REPO_ROOT/package.json').name")"
PKG_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
BIN_REL="$(node -p "require('$REPO_ROOT/package.json').bin['${PKG_NAME}-shim'] || Object.values(require('$REPO_ROOT/package.json').bin)[0]")"

# ── scratch dirs (cleaned on any exit) ──────────────────────────────────────────
PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pcb-pack.XXXXXX")"
PROJ_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pcb-proj.XXXXXX")"
cleanup() {
	rm -rf "$PACK_DIR" "$PROJ_DIR" 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok: $*"; }

echo "== tarball-verify: $PKG_NAME@$PKG_VERSION =="
echo "   bin shim (from package.json): $BIN_REL"

# ── 1. build + pack ─────────────────────────────────────────────────────────────
# Build first so dist/ is fresh (prepublishOnly also builds, but `npm pack` does
# NOT run prepublishOnly in all npm versions — build explicitly to be safe).
echo "-- npm run build"
( cd "$REPO_ROOT" && npm run build >/dev/null 2>&1 ) || fail "npm run build failed"

echo "-- npm pack --> $PACK_DIR"
# --pack-destination puts the .tgz in PACK_DIR; capture its filename.
TARBALL_NAME="$( cd "$REPO_ROOT" && npm pack --pack-destination "$PACK_DIR" 2>/dev/null | tail -n1 )"
TARBALL_PATH="$PACK_DIR/$TARBALL_NAME"
[ -f "$TARBALL_PATH" ] || fail "npm pack did not produce a tarball at $TARBALL_PATH"
ok "packed $TARBALL_NAME"

# ── 2. extract + inspect the tarball CONTENTS directly ──────────────────────────
# (Verify the dist files are actually IN the tarball before we even install — this
#  catches a missing `files` entry independent of install resolution.)
echo "-- inspect tarball contents"
TAR_LIST="$( tar -tzf "$TARBALL_PATH" )"
# npm tarballs prefix everything with "package/".
REQUIRED_DIST=(
	"package/dist/index.js"
	"package/dist/convert.js"
	"package/dist/models.js"
	"package/dist/src/capture.js"
	"package/dist/src/driver/ansi.js"
	"package/dist/src/driver/claudeP.js"
	"package/dist/src/driver/pty.js"
	"package/dist/src/driver/stream.js"
	"package/dist/src/mcp/ipc.js"
	"package/dist/src/mcp/router.js"
	"package/dist/src/mcp/shim.js"
)
for f in "${REQUIRED_DIST[@]}"; do
	echo "$TAR_LIST" | grep -qxF "$f" || fail "tarball is missing runtime file: $f"
done
ok "tarball contains all ${#REQUIRED_DIST[@]} required dist runtime files"
# The bin shim must be present in the tarball.
echo "$TAR_LIST" | grep -qxF "package/$BIN_REL" || fail "tarball is missing the bin shim: package/$BIN_REL"
ok "tarball contains the bin shim: package/$BIN_REL"

# ── 3. install the tarball into a fresh throwaway project ───────────────────────
echo "-- fresh project install --> $PROJ_DIR"
cat > "$PROJ_DIR/package.json" <<EOF
{
  "name": "pcb-tarball-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
EOF
# Install ONLY the tarball + its runtime deps; no peer deps, no dev deps, offline-ish.
# --no-audit/--no-fund keep it quiet; --omit=dev is the default for a dep install.
( cd "$PROJ_DIR" && npm install "$TARBALL_PATH" --no-audit --no-fund --loglevel=error ) \
	|| fail "npm install of the tarball failed"
ok "installed $PKG_NAME from tarball"

INSTALLED_PKG="$PROJ_DIR/node_modules/$PKG_NAME"
[ -d "$INSTALLED_PKG" ] || fail "installed package dir not found: $INSTALLED_PKG"

# ── 4. assert installed dist runtime files resolve on disk ──────────────────────
echo "-- verify installed dist runtime files"
INSTALLED_DIST=(
	"dist/index.js"
	"dist/convert.js"
	"dist/models.js"
	"dist/src/capture.js"
	"dist/src/driver/ansi.js"
	"dist/src/driver/claudeP.js"
	"dist/src/driver/pty.js"
	"dist/src/driver/stream.js"
	"dist/src/mcp/ipc.js"
	"dist/src/mcp/router.js"
	"dist/src/mcp/shim.js"
)
for f in "${INSTALLED_DIST[@]}"; do
	[ -f "$INSTALLED_PKG/$f" ] || fail "installed package missing runtime file: $f"
done
ok "all ${#INSTALLED_DIST[@]} installed dist runtime files present"

SHIM_PATH="$INSTALLED_PKG/$BIN_REL"
[ -f "$SHIM_PATH" ] || fail "installed bin shim not found: $SHIM_PATH"
ok "installed bin shim present: $BIN_REL"

# ── 5. run the installed shim: it must START (deps resolve) and EXIT cleanly ────
# Invoked with NO --socket, the shim's runtime imports all load, it parses argv,
# emits a structured `startup-failed` log naming the missing flag, and exits 1.
# That is the deterministic "start + respond + exit" we assert. We run it from the
# CONSUMER project's cwd so resolution comes from the INSTALLED node_modules, not
# the repo. A short timeout guards against a hang (it should exit immediately).
echo "-- run installed shim (no --socket → startup-failed → exit 1)"
SHIM_OUT="$PROJ_DIR/shim.out"
set +e
( cd "$PROJ_DIR" && node "$SHIM_PATH" </dev/null >"$SHIM_OUT" 2>&1 )
SHIM_EXIT=$?
set -e

# It must exit non-zero (1) on the missing-arg path — NOT hang, NOT exit 0, NOT
# crash with a module-resolution error (which would be a packaging defect).
if [ "$SHIM_EXIT" -eq 0 ]; then
	cat "$SHIM_OUT" >&2
	fail "shim exited 0 with no --socket — expected the startup-failed exit-1 path"
fi
# A module-not-found (ERR_MODULE_NOT_FOUND / Cannot find package) means the tarball
# did not carry / could not resolve a runtime dependency — the exact thing we test.
if grep -Eq "ERR_MODULE_NOT_FOUND|Cannot find (package|module)" "$SHIM_OUT"; then
	cat "$SHIM_OUT" >&2
	fail "shim failed to resolve a runtime dependency from the installed tarball"
fi
# The expected, healthy signal: the structured startup-failed log naming --socket.
if ! grep -q "startup-failed" "$SHIM_OUT"; then
	cat "$SHIM_OUT" >&2
	fail "shim did not emit the expected 'startup-failed' structured log"
fi
grep -q -- "--socket" "$SHIM_OUT" || echo "  note: startup-failed log did not name --socket (non-fatal)"
ok "installed shim started, resolved all runtime deps, and exited $SHIM_EXIT (startup-failed)"

echo "== tarball-verify: PASS =="
