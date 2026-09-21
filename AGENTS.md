# AGENTS.md

Guidance for coding agents (pi, Claude Code, Codex, …) working with code in this repository.

## What this is

Syneva is a CLI (`syneva`) that serves a localhost browser UI for reviewing a git diff. A human reviews (accept/reject changes, comment, ask questions), and a coding agent attaches to the same desk via CLI subcommands to receive the review, reply, and re-diff its edits into the open tab. No model runs inside Syneva — it is a protocol + interface only.

Product positioning lives in `PRODUCT.md`, the UI design language in `DESIGN.md` — read them before product or design decisions.

## Commands

Every command is a pnpm script in `package.json` — that file is the authoritative list (`dev`, `build`, `check`, `lint`, `lint:types`, `lint:fix`, `format`, `format:check`, `test`, `perf-smoke`, `release`). CI (`.github/workflows/ci.yml`) runs the same gates on Node 24 — all must pass. Run a single test file with `node --import tsx --test <file>`. The tooling needs Node 24 (`devEngines`); the published CLI keeps its `engines.node >= 22` contract.

## Test layout

Unit tests stay colocated with the file they test (`src/**/*.test.ts`, run by `pnpm test`). Everything end-to-end lives in `test/`: `test/benchmarks/` holds the frontend perf benchmarks (below), and future e2e suites join the same folder.

## Benchmarks

The perf timeline is tracked data, not a chat log: after a render-path change, measure the cold open (headless, via `pi-frontend-check`) and record the run with `node test/benchmarks/bench-dashboard.mjs --record <file>`, then `--check`. Read `test/benchmarks/README.md` for the run shape and `test/benchmarks/AGENTS.md` for the rules that keep runs comparable.

## Two compilation worlds

`src/` is split into a Node backend (`src/*.ts`, ESM NodeNext — intra-backend imports use `.js` extensions, compiled by `tsc` to `dist/`) and a browser UI (`src/ui/*`, Alpine.js bundled by esbuild from `src/ui/main.ts`, checked by `tsconfig.ui.json`). The two worlds never import each other at runtime: `src/types.ts` is the single source of truth for the shared wire shapes, and `src/ui/types.ts` re-exports what it needs type-only — change a wire type in `src/types.ts` alone.

Lint/format behaviour is the shared `@nextnode-solutions/standards` preset; `oxlint.config.ts`/`oxfmt.config.ts` hold only repo-specific ignores and narrow overrides with a stated reason.

## Render path

All render passes funnel through `src/ui/render.ts`. Before touching windowing or tokenization, read `render/token-pool/` and `render/virtual-diff.ts` — the adapter compensates for @pierre/diffs's one-time metadata adoption and height-reconciliation behavior, and windows must derive from already-parsed metadata (never re-parse diffs to split work). `scripts/bundle-budget.mjs` budgets the whole static import graph, not just `ui.js`. `@pierre/diffs` renumbers lines per render — display anchors are derived, raw file lines stay canonical.

## Key invariants

- `Decision` records (keyed `path:stableKey`) — not git staging and not the rendered diff — are the source of truth for accept/reject. They survive reloads even when accepting staged the hunk out of the working-tree diff.
- `contentHash`/`reviewedHash` pairs detect staleness: if the agent rewrites a block (or a file) after it was decided/approved, the decision/approval resets to pending on reload. The same pattern invalidates comment anchors (`anchorText` → re-anchoring → `unanchored`) and guides (`baseDiffHash`).
- Desks are idempotent per repo+session: `stablePort` hashes repo+session to a port in 41000–50999 so a restarted desk binds the same origin and an open tab self-heals; a desk lock file is trusted only if the server actually answers (`deskAlive`).
- `server/state-cache.ts` caches the serialized browser response per review revision: `DeskContext.serialize` invalidates around mutations, and the cache must never be keyed solely on `baseDiffHash`.

## Harness module

Everything a coding-agent harness loads from this package (the extension entry, `/plan` and `/review` prompts, the syneva skill, the syneva-answer subagent) lives under `extension/` — read `extension/README.md` before touching it. It is an adapter layer only: it talks to desks through the CLI/HTTP contract and must not grow business logic.

## Agent contract

`src/spec.ts` is the single source of truth for the CLI/HTTP contract (flags, events, `ReviewResult` shape) and is printed by `syneva spec` — the skill and the server's error responses point consuming agents at it. If you change the CLI flags, events, or ReviewResult shape, update `src/spec.ts` in the same change. `src/spec.test.ts`, `src/cli.test.ts`, and `src/server.test.ts` cover the documented contract.

## Conventions

- Commits follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, …); `changelogen` infers the semver bump from the prefix. Version bumps and CHANGELOG are handled by `pnpm release` — don't edit CHANGELOG.md or the version by hand.
- Comments in this codebase explain *why* and record invariants; match that style.
