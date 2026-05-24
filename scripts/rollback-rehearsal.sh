#!/usr/bin/env bash
# T4.6a — Rollback rehearsal.
#
# Validates the Phase-3 cut-over commit (089915e) can be cleanly reverted
# without leaving the tree in a non-building state. This is the safety
# net for "v1.0.0 broke production; revert the SDK-deletion."
#
# What it does:
#   1. Creates a scratch branch from HEAD.
#   2. `git revert` the Phase-3 commit on the scratch branch.
#   3. Runs `npm install && npm run build && npm run test:unit`.
#   4. Reports PASS/FAIL.
#   5. Cleans up the scratch branch (does NOT touch the working branch).
#
# Run from anywhere inside the repo. Idempotent (cleans up its own scratch
# branch on next run).

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

SCRATCH_BRANCH="rollback-rehearsal-$(date +%s)"
PHASE_3_COMMIT="089915e"  # feat(phase-3): delete SDK path
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

cleanup() {
	local rc=$?
	# Return to original branch.
	if [[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "$ORIG_BRANCH" ]]; then
		git checkout -q "$ORIG_BRANCH" 2>/dev/null || true
	fi
	# Delete scratch branch.
	git branch -D "$SCRATCH_BRANCH" 2>/dev/null || true
	exit "$rc"
}
trap cleanup EXIT

echo "==> Rollback rehearsal"
echo "    original branch: $ORIG_BRANCH"
echo "    scratch branch:  $SCRATCH_BRANCH"
echo "    revert target:   $PHASE_3_COMMIT"

# Bail if working tree is dirty — revert would conflict with uncommitted edits.
if [[ -n "$(git status --porcelain)" ]]; then
	echo "FAIL: working tree dirty; commit or stash before rehearsing rollback"
	exit 1
fi

# Create scratch branch.
git checkout -b "$SCRATCH_BRANCH" >/dev/null

# Revert the Phase-3 cut-over commit. Use --no-edit so the revert commit
# message is auto-generated; we don't care about prose in a throwaway branch.
if ! git revert --no-edit "$PHASE_3_COMMIT" 2>&1; then
	echo "FAIL: git revert produced conflicts on Phase-3 commit"
	# Abort the revert so cleanup() can switch branches.
	git revert --abort 2>/dev/null || true
	exit 1
fi

echo "==> Revert clean; reinstalling deps + rebuilding"

# Re-install — the revert restores @anthropic-ai/* deps in package.json.
if ! npm install --silent 2>&1 | tail -10; then
	echo "FAIL: npm install on reverted tree failed"
	exit 1
fi

# Build.
if ! npm run build 2>&1 | tail -10; then
	echo "FAIL: npm run build on reverted tree failed"
	exit 1
fi

# Unit tests.
if ! npm run test:unit 2>&1 | tail -5; then
	echo "FAIL: npm run test:unit on reverted tree failed"
	exit 1
fi

echo ""
echo "PASS: Phase-3 commit ($PHASE_3_COMMIT) reverts cleanly. Build + unit tests green on the reverted tree."

# Restore @anthropic-ai deps removal on original branch — we still need
# to npm-install on the original branch on exit, else node_modules would
# carry the reverted deps after this script runs.
git checkout -q "$ORIG_BRANCH"
npm install --silent >/dev/null 2>&1 || true

exit 0
