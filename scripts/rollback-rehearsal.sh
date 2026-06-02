#!/usr/bin/env bash
# scripts/rollback-rehearsal.sh  (task T4.6a — Phase-3 cut-over rollback rehearsal)
#
# Rehearses reverting the Phase-3 cut-over (the commit that DELETED the in-process
# Claude Agent SDK inference path, making claude-p the sole driver) on a throwaway
# SCRATCH branch, then runs typecheck + build + unit tests to see whether the tree
# that the revert produces is buildable/green, and finally cleans up (switch back,
# delete scratch branch, restore any stashed working-tree changes).
#
# WHY THIS EXISTS: it is the documented, runnable "break glass" procedure for an
# emergency rollback to the SDK driver. We keep it CORRECT + RUNNABLE so that if
# claude-p turns out to be untenable in production, an operator can run this (or
# follow its commented procedure) to get back to a working SDK tree quickly.
#
# ───────────────────────────────────────────────────────────────────────────────
# IMPORTANT — THE REVERT IS *MESSY* (read before relying on a green result):
# ───────────────────────────────────────────────────────────────────────────────
# The Phase-3 cut-over commit ($CUTOVER below, "refactor!: Phase-3 cut-over") did
# THREE things that make a pure `git revert` insufficient on its own:
#
#   1. It DELETED the SDK-era test files (tests/fixtures/mock-sdk-query.mjs,
#      tests/int-output-capture.mjs, tests/unit-output-capture-{error-paths,
#      prompt-wiring,stream-events}.mjs). Reverting RESTORES those files — and they
#      `import @anthropic-ai/claude-agent-sdk`, exercise the SDK seam, and assume
#      the SDK event loop in index.ts. So a revert brings back tests for code it
#      also (correctly) brings back.
#
#   2. It DROPPED the SDK dependencies from package.json
#      (@anthropic-ai/claude-agent-sdk + @anthropic-ai/sdk). Reverting RESTORES the
#      package.json entries, but the packages are NOT in node_modules anymore — so
#      `npm run typecheck` / `test:unit` will fail with module-resolution errors
#      until you `npm install` to re-fetch the restored SDK deps. This rehearsal
#      runs `npm install` after the revert for exactly this reason.
#
#   3. It rewrote index.ts (≈1019-line diff) + convert.ts + README for the claude-p
#      architecture. The revert may CONFLICT against later commits that touched the
#      same files (notably the package.json `test` script line changed by a later
#      "serialize int-*.mjs" commit). Conflicts are reported and abort the rehearsal
#      (we do NOT auto-resolve — a human must, since this is the rollback contract).
#
# THEREFORE the expected outcome of running this is one of:
#   (a) revert conflicts  → the script reports the conflicted paths and aborts the
#       revert cleanly. THIS IS AN ACCEPTABLE rehearsal result: it tells the
#       operator the exact files to hand-resolve for a real rollback.
#   (b) revert applies but typecheck/build/test fail until/unless the restored SDK
#       deps install AND the restored SDK tests align with the reverted index.ts.
#   (c) full green (only if the tree at HEAD reverts cleanly AND `npm install`
#       restores the SDK deps AND the restored SDK suites still pass).
#
# The rehearsal's JOB is to SURFACE which of (a)/(b)/(c) holds today and leave a
# clean tree behind — NOT to force green. The exit code reflects whether a clean,
# buildable, unit-green SDK tree was reached (0) or whether the rollback needs
# manual steps (non-zero), with the reason printed.
#
# ───────────────────────────────────────────────────────────────────────────────
# MANUAL ROLLBACK PROCEDURE (if you are doing this for real, not rehearsing):
# ───────────────────────────────────────────────────────────────────────────────
#   1. git switch -c rollback/sdk-restore <current-prod-ref>
#   2. git revert --no-commit $CUTOVER
#   3. Resolve any conflicts (most likely package.json's `test` script + scripts;
#      keep the SDK deps from the revert, keep later infra fixes from HEAD).
#   4. git commit -m "revert!: roll back Phase-3 cut-over — restore SDK driver"
#   5. npm install            # re-fetch the restored @anthropic-ai/* deps
#   6. npm run typecheck && npm run build && npm run test:unit
#   7. If restored SDK suites are stale vs other later changes, fix or quarantine
#      them; the SDK *driver* code is what matters for the rollback, not every test.
#   8. Set CLAUDE_BRIDGE_DRIVER=sdk (the reverted code re-enables it) and smoke-test.
#
# ───────────────────────────────────────────────────────────────────────────────
# USAGE:  bash scripts/rollback-rehearsal.sh
#   Env:  SKIP_NPM_INSTALL=1   skip the post-revert `npm install` (faster dry check)
#         KEEP_SCRATCH=1       do not delete the scratch branch / switch back (debug)
#
# SAFETY: refuses to run with a detached HEAD. STASHES any dirty working tree first
# and restores it in the cleanup trap, so uncommitted work (e.g. the harness's
# not-yet-committed changes) is never lost.

set -uo pipefail   # NOTE: deliberately NOT -e; we want to catch+report step failures.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root $REPO_ROOT" >&2; exit 2; }

SCRATCH_BRANCH="rollback-rehearsal-tmp"

# The Phase-3 cut-over commit (deleted the SDK path). Resolved by its subject so the
# script stays correct if the SHA is rebased; falls back to the known SHA.
CUTOVER="$(git log --grep='Phase-3 cut-over' --format='%H' -n 1 2>/dev/null)"
[ -n "$CUTOVER" ] || CUTOVER="d8b330bdff3b6d6f0ce4c766423836644f85db36"

# ── preconditions ───────────────────────────────────────────────────────────────
ORIG_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [ -z "$ORIG_BRANCH" ]; then
	echo "FATAL: detached HEAD — check out a branch before rehearsing rollback." >&2
	exit 2
fi
if ! git cat-file -e "${CUTOVER}^{commit}" 2>/dev/null; then
	echo "FATAL: cut-over commit $CUTOVER not found in this repo." >&2
	exit 2
fi

echo "== rollback rehearsal =="
echo "   repo:          $REPO_ROOT"
echo "   orig branch:   $ORIG_BRANCH"
echo "   cut-over:      $CUTOVER ($(git log --format='%s' -n1 "$CUTOVER" | cut -c1-60))"
echo "   scratch:       $SCRATCH_BRANCH"

# ── stash dirty tree so we never clobber uncommitted work ────────────────────────
STASHED=0
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	echo "-- working tree dirty: stashing tracked changes"
	if git stash push --keep-index --message "rollback-rehearsal-autostash" >/dev/null 2>&1; then
		STASHED=1
	else
		echo "FATAL: could not stash dirty tree; aborting to avoid clobbering work." >&2
		exit 2
	fi
fi

# ── cleanup trap: always return to the original branch + restore stash ───────────
cleanup() {
	local rc=$?
	if [ "${KEEP_SCRATCH:-0}" != "1" ]; then
		# Abort any in-progress revert/merge so the branch switch is allowed.
		git revert --abort >/dev/null 2>&1 || true
		git merge --abort >/dev/null 2>&1 || true
		git switch --force "$ORIG_BRANCH" >/dev/null 2>&1 || git checkout --force "$ORIG_BRANCH" >/dev/null 2>&1 || true
		git branch -D "$SCRATCH_BRANCH" >/dev/null 2>&1 || true
		if [ "$STASHED" = "1" ]; then
			git stash pop >/dev/null 2>&1 || echo "WARN: could not auto-restore stash; see 'git stash list'." >&2
		fi
	else
		echo "KEEP_SCRATCH=1: leaving scratch branch + stash in place for inspection."
	fi
	exit "$rc"
}
trap cleanup EXIT INT TERM

# ── 1. scratch branch ────────────────────────────────────────────────────────────
echo "-- git switch -c $SCRATCH_BRANCH"
git branch -D "$SCRATCH_BRANCH" >/dev/null 2>&1 || true
git switch -c "$SCRATCH_BRANCH" >/dev/null 2>&1 || git checkout -b "$SCRATCH_BRANCH" >/dev/null 2>&1 || {
	echo "FATAL: could not create scratch branch $SCRATCH_BRANCH" >&2
	exit 2
}

# ── 2. revert the cut-over ───────────────────────────────────────────────────────
echo "-- git revert --no-commit $CUTOVER"
if git revert --no-commit "$CUTOVER" >/dev/null 2>&1; then
	echo "  revert applied cleanly to the index/working tree."
	REVERT_CLEAN=1
else
	echo "  revert produced CONFLICTS (expected — see header). Conflicted paths:"
	git diff --name-only --diff-filter=U | sed 's/^/    - /'
	echo ""
	echo "  RESULT (a): the rollback is NOT a clean cherry-revert. For a real rollback,"
	echo "  hand-resolve the paths above (header step 3), then continue from step 4."
	echo "  Rehearsal cannot proceed to build/test on a conflicted tree — aborting revert."
	git revert --abort >/dev/null 2>&1 || true
	# A surfaced conflict is the EXPECTED, informative outcome — exit non-zero to
	# signal "rollback needs manual steps", which is the honest rehearsal verdict.
	exit 1
fi

# Commit the revert so the tree is in a definite state for build/test.
git commit --no-verify -m "revert!: rehearse Phase-3 cut-over rollback (restore SDK driver)" >/dev/null 2>&1 || true

# ── 3. (re)install restored SDK deps ─────────────────────────────────────────────
# The revert restores @anthropic-ai/* in package.json but they are not installed —
# typecheck/test would otherwise fail with module-resolution errors. (Skippable.)
if [ "${SKIP_NPM_INSTALL:-0}" = "1" ]; then
	echo "-- SKIP_NPM_INSTALL=1: not running npm install (restored SDK deps will be missing)"
else
	echo "-- npm install (re-fetch restored @anthropic-ai/* deps)"
	npm install --no-audit --no-fund --loglevel=error || echo "  WARN: npm install failed; typecheck/test below will likely fail."
fi

# ── 4. typecheck + build + unit tests on the reverted tree ───────────────────────
STEP_FAIL=0
run_step() {
	local label="$1"; shift
	echo "-- $label"
	if "$@"; then
		echo "  PASS: $label"
	else
		echo "  FAIL: $label"
		STEP_FAIL=1
	fi
}
run_step "npm run typecheck" npm run typecheck
run_step "npm run build"     npm run build
run_step "npm run test:unit" npm run test:unit

# ── 5. verdict ───────────────────────────────────────────────────────────────────
echo ""
if [ "$STEP_FAIL" = "0" ]; then
	echo "== rollback rehearsal: GREEN — reverting the cut-over yields a buildable, unit-green SDK tree."
	VERDICT=0
else
	echo "== rollback rehearsal: NEEDS MANUAL STEPS — the revert applied but typecheck/build/test did"
	echo "   not all pass (RESULT (b) in the header). This is an acceptable rehearsal outcome: the"
	echo "   restored SDK tests/deps need the manual alignment described in the MANUAL ROLLBACK"
	echo "   PROCEDURE above. The SDK *driver* code itself is restored by the revert."
	VERDICT=1
fi

exit "$VERDICT"
