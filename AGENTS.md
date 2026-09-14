# AGENTS.md

Guidance for coding agents (pi, Claude Code, Codex, …) working with code in this repository.

## What this is

Galley is a CLI (`galley`) that serves a localhost browser UI for reviewing a git diff. A human reviews (accept/reject changes, comment, ask questions), and a coding agent attaches to the same desk via CLI subcommands to receive the review, reply, and re-diff its edits into the open tab. No model runs inside Galley — it is a protocol + interface only.

## Commands

```bash
pnpm dev          # esbuild --watch for the UI + run the CLI from source via tsx
pnpm build        # tsc (backend) + tsc -p tsconfig.ui.json (UI typecheck) + esbuild bundle + copy index.html
pnpm check        # typecheck backend, UI, extensions, tests and tooling, no emit
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

## Two compilation worlds

`src/` is split into a Node backend and a browser UI that are built and type-checked separately:

- **Backend** (`src/*.ts`, excluding `src/ui/`): ESM with NodeNext resolution — intra-backend imports use `.js` extensions. Compiled by `tsc` to `dist/`. Entry: `src/cli.ts` (`dist/cli.js` is the published bin).
- **UI** (`src/ui/*.ts`): browser code (Alpine.js) bundled by esbuild from `src/ui/main.ts` into `dist/ui.js`; type-checked (noEmit) with `tsconfig.ui.json` (bundler resolution, DOM libs). All markup lives in `src/ui/index.html` (formatted by oxfmt, copied to `dist/`), with `@pierre/diffs` rendering the diff. All render passes funnel through `src/ui/render.ts`; the @pierre island (`src/ui/render/diff-instance.ts`) mounts a `FileDiff` over a worker pool (`src/ui/render/worker-pool.ts`) — @pierre's second constructor argument, so Shiki tokenization runs in `dist/worker.js` (built by the same esbuild script, served as `/worker.js`) instead of freezing the tab. Guard discipline for the render path: a `(diffKey, renderSignature)` pair from the last painted pass skips no-op re-renders (see `render/render-signature.ts`), and the expand-unchanged preference caps at `EXPAND_LINES_MAX` whole-file lines (`render/expand-cap.ts`) — keep both in mind when touching `src/ui/render/`.

The two worlds do not import each other at runtime. `src/types.ts` is the single source of truth for the shared shapes (ReviewState, ReviewResult, Guide, …); `src/ui/types.ts` (and `src/ui/walkthrough.ts`) re-export what they need via `import type { ... } from "../types"` — type-only, erased by esbuild, so no backend code ships in the UI bundle and the runtime boundary holds. Change a wire type in `src/types.ts` alone; the UI picks it up through the re-export.

## Architecture

**Backend flow:** `cli.ts` parses args and dispatches: desk starts (`galley`, `galley file <path>`, `galley pr <ref>`) build a `ReviewState` and call `startServer`; agent subcommands (`await`, `comment`, `reload`) find the live desk and talk to it over HTTP. `git/` is the git plumbing + unified-diff parser. `state/` is the core, split by concern: `build.ts` builds a `ReviewState`, `diff-source.ts`/`diff-files.ts`/`untracked.ts` turn a mode into files + change blocks (with their `stableKey`/`contentHash`), `guide-resolve.ts` resolves a guide's skim spans and declared moves, `reconcile.ts` reconciles the rebuilt diff with the saved one, `persistence.ts` reads/writes the review file, `decisions.ts`/`comments.ts`/`review-result.ts` derive the reviewer records and the agent-facing result, and `identity.ts`/`desk.ts` own the deterministic ports and desk locks. `server.ts` starts the desk and wires its collaborators; `server/` holds them: `binding.ts` (bind address + origin guard), `router.ts`/`routes.ts` (the `METHOD /path` registry that serves the UI and every `/api/*` route, including the long-poll `/api/await-send` that backs `galley await`), `events.ts`/`activity.ts`/`shutdown.ts` (the tagged event stream, the ephemeral `status` line, the idle watchdog), and the HTTP-free actions the routes call (`reload-desk.ts`, `send-review.ts`, `staging.ts`, `add-comment.ts`, `open-editor.ts`, `reset-review.ts`).

**Key invariants in `state/`:**

- `Decision` records (keyed `path:stableKey`) — not git staging and not the rendered diff — are the source of truth for accept/reject. They survive reloads even when accepting staged the hunk out of the working-tree diff.
- `contentHash`/`reviewedHash` pairs detect staleness: if the agent rewrites a block (or a file) after it was decided/approved, the decision/approval resets to pending on reload. The same pattern invalidates comment anchors (`anchorText` → re-anchoring → `unanchored`) and guides (`baseDiffHash`).
- Desks are idempotent per repo+session: `stablePort` hashes repo+session to a port in 41000–50999 so a restarted desk binds the same origin and an open tab self-heals; a desk lock file is trusted only if the server actually answers (`deskAlive`).

**Agent contract:** plain JSON on stdout. `galley await` long-polls and prints one tagged event — `{"kind":"question",…}` (answer now via `galley comment`) or `{"kind":"review","result":{…ReviewResult…}}` (the reviewer hit Send). The contract is the single source of truth in `src/spec.ts` (printed by `galley spec`); the skill (`skills/galley/SKILL.md`) is bootstrap-only and points consuming agents at `galley spec`, and the server's error responses do too. **If you change the CLI flags, events, or ReviewResult shape, update `src/spec.ts` in the same change.** `src/spec.test.ts`, `src/cli.test.ts`, and `src/server.test.ts` cover the documented contract and its CLI/HTTP behavior.

**UI:** an Alpine.js app with a global store (`src/ui/store.ts`); `poll.ts` polls `/api/state`, `render.ts` renders the diff via `@pierre/diffs` (which renumbers lines per render — display anchors are derived, raw file lines stay canonical), `keys.ts` holds the keyboard-first command map, and `guide.ts`/`tree.ts`/`decisions.ts` etc. are feature modules.

## Conventions

- Commits follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, …). `changelogen` groups them into the changelog and infers the semver bump, so the prefix matters — use `feat:` for user-facing additions and `fix:` for bug fixes.
- Comments in this codebase explain *why* and record invariants (see `state/reconcile.ts`, `state/diff-files.ts`, `types.ts`); match that style.
- Formatting/linting is oxfmt/oxlint — run `pnpm format` and `pnpm lint:fix` rather than hand-formatting.
- Version bumps and CHANGELOG are handled by `changelogen` via `pnpm release` (tag push triggers the npm publish workflow); don't edit CHANGELOG.md or the version by hand.
