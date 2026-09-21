# AGENTS.md

Guidance for coding agents (pi, Claude Code, Codex, …) working with code in this repository.

## What this is

Syneva is a CLI (`syneva`) that serves a localhost browser UI for reviewing a git diff. A human reviews (accept/reject changes, comment, ask questions), and a coding agent attaches to the same desk via CLI subcommands to receive the review, reply, and re-diff its edits into the open tab. No model runs inside Syneva — it is a protocol + interface only.

## Commands

```bash
pnpm dev          # esbuild --watch for the UI + run the CLI from source via tsx
pnpm build        # tsc (backend) + tsc -p tsconfig.ui.json (UI typecheck) + esbuild bundle + copy index.html
pnpm check        # typecheck every world, no emit - 3 configs: tsconfig.json (backend emit, checked noEmit), tsconfig.test.json (backend tests + extensions + lint configs, NodeNext), tsconfig.ui.json (browser world incl. its tests, bundler + DOM)
pnpm lint         # oxlint (shared @nextnode-solutions/standards preset)
pnpm lint:types   # oxlint --type-aware (tsgolint)
pnpm lint:fix     # oxlint --fix — safe fixes only, never --fix-dangerously
pnpm format       # oxfmt --write (repo-wide, in place)
pnpm format:check # oxfmt --check — the formatting gate
pnpm test         # node:test via tsx, all src/**/*.test.ts
pnpm release      # lint + lint:types + format:check + check + test + build + changelogen --release --push
```

Lint/format behaviour is the shared `@nextnode-solutions/standards` preset, imported by
`oxlint.config.ts` / `oxfmt.config.ts`; those files hold only repo-specific ignores and narrow
`overrides` with a stated reason. Excluded from formatting: markdown (hand-maintained docs) and
the generated `src/ui/icon-data.ts`. `src/ui/index.html` is formatted too, and because only a
browser can judge that markup, oxfmt's rewrite of it is checked by booting the desk and comparing
the rendered DOM, computed styles and element geometry before/after. The tooling itself needs
Node 24 (`devEngines`); the published CLI keeps its `engines.node >= 22` contract.

Run a single test file:

```bash
node --import tsx --test src/state/reconcile.test.ts
```

CI (`.github/workflows/ci.yml`) runs lint, lint:types, format:check, check, build, test and perf-smoke on Node 24 — all must pass.

## Test layout

Unit tests stay colocated with the file they test (`src/**/*.test.ts`, run by `pnpm test`). Everything
end-to-end lives in `test/`: `test/benchmarks/` holds the frontend perf benchmarks (below), and future
e2e suites join the same folder.

## Benchmarks

The frontend perf timeline is tracked data, not a chat log: after a render-path change, measure the
cold open through `pi-frontend-check` (headless) and record the run with
`node test/benchmarks/bench-dashboard.mjs --record <file>`, then `--check`. Read `test/benchmarks/README.md` for the
run shape and stage definitions, and `test/benchmarks/AGENTS.md` for the rules that keep runs comparable
(record rejected variants too, one milestone per batch, report the spread). The timeline lives in
`test/benchmarks/history.json` and renders to the committed `test/benchmarks/dashboard.html`.

## Two compilation worlds

`src/` is split into a Node backend and a browser UI that are built and type-checked separately:

- **Backend** (`src/*.ts`, excluding `src/ui/`): ESM with NodeNext resolution — intra-backend imports use `.js` extensions. Compiled by `tsc` to `dist/`. Entry: `src/cli.ts` (`dist/cli.js` is the published bin).
- **UI** (`src/ui/*.ts`): browser code (Alpine.js) bundled by esbuild from `src/ui/main.ts` into `dist/ui.js`; type-checked (noEmit) with `tsconfig.ui.json` (bundler resolution, DOM libs). All markup lives in `src/ui/index.html` (formatted by oxfmt, copied to `dist/`), with `@pierre/diffs` rendering the diff. All render passes funnel through `src/ui/render.ts`; the diff and markdown engines load dynamically from `dist/chunks/` (served only through the restricted `/chunks/*` route). `scripts/bundle-budget.mjs` budgets the whole static import graph, not just `ui.js`. The @pierre island (`src/ui/render/diff-instance.ts`) keeps one active instance: `render/virtual-diff.ts` adapts `VirtualizedFileDiff` to logical navigation and scroll anchors; collapsed skim blocks use `FileDiff` because their row hiding needs a full layout. Both take `render/worker-pool.ts` as their tokenizer, which runs our own adapter (`render/token-pool/`) over windowed slices through `/worker.js` (entry `src/ui/worker/diff-token-worker.ts`): a full plain skeleton per job, token windows merged progressively into it, final result cached per contentHash + token options. Never re-parse diffs to split work - windows derive from the already-parsed metadata only. Read that adapter (and the @pierre/diffs tag in package.json on any bump) before changing windowing - the virtual adapter underneath compensates for the library's one-time metadata adoption and height-reconciliation behavior. Note: the shiki-shim esbuild plugin still reroutes @pierre's bare `shiki` specifier to the curated lean set - @pierre accepts shiki ^4 since 1.4.3 (no duplicate copy anymore), but its bare barrel still drags the full grammar set + wasm in, which is why the reroute stays and the TOTAL budget is provisional (see scripts/bundle-budget.mjs). Guard discipline for the render path: a `(diffKey, renderSignature)` pair from the last painted pass skips no-op re-renders (see `render/render-signature.ts`), and the expand-unchanged preference caps at `EXPAND_LINES_MAX` whole-file lines (`render/expand-cap.ts`) — keep both in mind when touching `src/ui/render/`.

The two worlds do not import each other at runtime. `src/types.ts` is the single source of truth for the shared shapes (ReviewState, ReviewResult, Guide, …); `src/ui/types.ts` (and `src/ui/walkthrough.ts`) re-export what they need via `import type { ... } from "../types"` — type-only, erased by esbuild, so no backend code ships in the UI bundle and the runtime boundary holds. Change a wire type in `src/types.ts` alone; the UI picks it up through the re-export.

## Architecture

**Backend flow:** `cli.ts` parses args and dispatches: desk starts (`syneva`, `syneva file <path>`, `syneva pr <ref>`) build a `ReviewState` and call `startServer`; agent subcommands (`await`, `comment`, `reload`) find the live desk and talk to it over HTTP. `git/` is the git plumbing + unified-diff parser. `state/` is the core, split by concern: `build.ts` builds a `ReviewState`, `diff-source.ts`/`diff-files.ts`/`untracked.ts` turn a mode into files + change blocks (with their `stableKey`/`contentHash`), `guide-resolve.ts` resolves a guide's skim spans and declared moves, `reconcile.ts` reconciles the rebuilt diff with the saved one, `persistence.ts` reads/writes the review file, `decisions.ts`/`comments.ts`/`review-result.ts` derive the reviewer records and the agent-facing result, and `identity.ts`/`desk.ts` own the deterministic ports and desk locks. `server.ts` starts the desk and wires its collaborators; `server/` holds them: `binding.ts` (bind address + origin guard), `router.ts`/`routes.ts` (the `METHOD /path` registry that serves the UI and every `/api/*` route, including the long-poll `/api/await-send` that backs `syneva await`), `events.ts`/`activity.ts`/`shutdown.ts` (the tagged event stream, the ephemeral `status` line, the idle watchdog), and the HTTP-free actions the routes call (`reload-desk.ts`, `send-review.ts`, `staging.ts`, `add-comment.ts`, `open-editor.ts`, `reset-review.ts`).

`server/state-cache.ts` caches the serialized browser response per review revision and transient status. `DeskContext.serialize` invalidates around mutations and bypasses reuse while a writer yields; staged-snapshot refresh invalidates only when the index changes. Never key this cache solely on `baseDiffHash`.

**Key invariants in `state/`:**

- `Decision` records (keyed `path:stableKey`) — not git staging and not the rendered diff — are the source of truth for accept/reject. They survive reloads even when accepting staged the hunk out of the working-tree diff.
- `contentHash`/`reviewedHash` pairs detect staleness: if the agent rewrites a block (or a file) after it was decided/approved, the decision/approval resets to pending on reload. The same pattern invalidates comment anchors (`anchorText` → re-anchoring → `unanchored`) and guides (`baseDiffHash`).
- Desks are idempotent per repo+session: `stablePort` hashes repo+session to a port in 41000–50999 so a restarted desk binds the same origin and an open tab self-heals; a desk lock file is trusted only if the server actually answers (`deskAlive`).

**Harness module:** everything a coding-agent harness loads from this package (the extension entry, `/plan` and `/review` prompts, the syneva skill, the syneva-answer subagent) lives under `extension/` — read `extension/README.md` before touching it. It is an adapter layer only: it talks to desks through the CLI/HTTP contract below and must not grow business logic.

**Agent contract:** plain JSON on stdout. `syneva await` long-polls and prints one tagged event — `{"kind":"question",…}` (answer now via `syneva comment`) or `{"kind":"review","result":{…ReviewResult…}}` (the reviewer hit Send). The contract is the single source of truth in `src/spec.ts` (printed by `syneva spec`); the skill (`extension/skills/syneva/SKILL.md`) is bootstrap-only and points consuming agents at `syneva spec`, and the server's error responses do too. **If you change the CLI flags, events, or ReviewResult shape, update `src/spec.ts` in the same change.** `src/spec.test.ts`, `src/cli.test.ts`, and `src/server.test.ts` cover the documented contract and its CLI/HTTP behavior.

**UI:** an Alpine.js app with a global store (`src/ui/store.ts`); `poll.ts` polls `/api/state`, `render.ts` renders the diff via `@pierre/diffs` (which renumbers lines per render — display anchors are derived, raw file lines stay canonical), `keys.ts` holds the keyboard-first command map, and `guide.ts`/`tree.ts`/`decisions.ts` etc. are feature modules.

## Conventions

- Commits follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, …). `changelogen` groups them into the changelog and infers the semver bump, so the prefix matters — use `feat:` for user-facing additions and `fix:` for bug fixes.
- Comments in this codebase explain *why* and record invariants (see `state/reconcile.ts`, `state/diff-files.ts`, `types.ts`); match that style.
- Formatting/linting is oxfmt/oxlint — run `pnpm format` and `pnpm lint:fix` rather than hand-formatting.
- Version bumps and CHANGELOG are handled by `changelogen` via `pnpm release` (tag push triggers the npm publish workflow); don't edit CHANGELOG.md or the version by hand.
