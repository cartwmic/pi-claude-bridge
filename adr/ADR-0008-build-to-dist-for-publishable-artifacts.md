# ADR-0008: Packaging — build to `dist/` for publishable artifacts

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

Pre-v1.0.0, the bridge shipped as TypeScript loaded via pi's `tsx`-aware extension loader. ADR-0003 + ADR-0007 introduce a `bin` entry (`pi-claude-bridge-shim`) invoked by `claude --mcp-config` as a subprocess. That subprocess is not loaded by pi's TS-aware loader — it's spawned by `claude` (a Rust binary, no TypeScript awareness) which `exec`s `node <path>`. Node cannot execute `.ts` files directly.

## Decision Drivers

- `bin` entry must be a JS file runnable by `node <path>` directly
- Existing TS-only flow for `index.ts` (pi extension entry) still works
- Published tarball must be self-contained (no `tsx` runtime dependency)
- Source → artifact mapping should stay legible for debugging

## Considered Options

### Option A: tsc build to `dist/`
New `tsconfig.build.json` produces JS in `dist/`. `npm run build` runs it. `package.json` `files` whitelist includes `dist/**`. `package.json` `bin` points at `dist/mcp/shim.js`. Source TS files still shipped for pi extension loader.

**Pros:** standard TypeScript library pattern; tsc is sufficient; debugging via sourcemaps; published tarball is self-contained.
**Cons:** adds a build step to release flow; bundles 2x file count (source + dist).

### Option B: Ship `src/**` as TypeScript; require `tsx` at runtime for the bin
**Pros:** zero build step.
**Cons:** the `bin` is spawned by `claude` (not by pi). The PATH that subprocess has is not guaranteed to include `tsx`. `node <path>` cannot run `.ts`. Rejected.

### Option C: Bundle with esbuild / rollup
**Pros:** smaller dist; tree-shaking.
**Cons:** introduces bundler dependency; obscures source→artifact mapping; tsc is sufficient.

### Option D: Publish two packages (`pi-claude-bridge` + `pi-claude-bridge-shim`)
**Pros:** cleaner conceptual split.
**Cons:** doubles release coordination; rejected for v1.

## Decision Outcome

**Chosen option:** A — tsc build to `dist/`.

**Rationale:** without a build step the `bin` entry doesn't work on user machines (the shim is a `.ts` file `node` cannot execute). Adopt the standard TypeScript-library publish pattern: ship source TS for pi's extension loader + compiled JS in `dist/` for the bin entry.

## Consequences

**Positive:**
- `bin` entry works on fresh installs without `tsx`
- Published tarball self-contained
- `npm run build` produces predictable artifacts
- Debugging via sourcemaps

**Negative:**
- Release adds a build step (verified by T4.4a tarball verification test)
- 2x file count in tarball (source + dist)
- `prepublishOnly` script must enforce build before publish

**Neutral:**
- Sourcemaps stripped from tarball via `.npmignore` (`dist/**/*.map`) to reduce size

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D14)
- Related ADRs: ADR-0003 (MCP shim is the bin entry), ADR-0007 (hook relay shares the bin)
- Verification: `tests/int-tarball-verification.mjs`
