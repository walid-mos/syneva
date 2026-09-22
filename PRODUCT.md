# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** any developer reviewing code written by a coding agent (Claude Code, Cursor, Codex, pi, a shell script). Their situation: a large or unfamiliar diff has landed in their working tree, staged index, or a branch, and the tool that produced it will act again the moment it hears back. Their job is to work through that diff — accept, reject, comment, ask — and hand a structured verdict back to the agent without leaving the surface.

**Secondary (a user, not a channel):** the coding agent on the other end. Syneva is built to be driven by it: it attaches over CLI subcommands, receives events, answers questions, re-diffs its own edits into the open tab.

The author is the daily user of the tool. Success is measured by how good the surface is for that daily loop, not by install counts.

## Product Purpose

Syneva is an **integrated review environment (IRE)** for code you didn't write by hand. It serves a localhost browser desk over a git diff: the human accepts/rejects individual changes, leaves per-line and whole-file comments, asks the agent questions, and clicks **Send to Agent**. The desk does not close on send — it stays live across rounds, so the same tab carries the whole conversation: the agent acts on the review, re-diffs its edits in place, and answers questions as threads in the same view.

It exists because code editors and IDEs were designed for a coding-first world. Their diff view is adequate for a glance and poor for working through a big changeset or going back and forth with the agent that produced it. Syneva is an opinionated answer to what that surface should be.

Success = being the best review surface for its author's own agent-driven review loop. Wider adoption is a bonus, never the target, and never a reason to make the product worse for that loop.

## Positioning

A protocol and an interface, nothing more. Three commitments a neighboring review tool could not truthfully copy:

1. **No model runs inside Syneva.** It never calls an LLM and never orchestrates one. It renders the diff, validates the structured input it is given, and hands a result back. The review grouping, the answers to the reviewer's questions, and the code changes are all the *user's* agent's work.
2. **Your agent, not ours.** The contract is plain JSON on stdout plus a localhost HTTP server, with no assumption about who is on the other end. An editor-integrated or agent-vendor review pane cannot make that claim.
3. **The review is the human's.** Decisions are recorded verdicts (`path:stableKey`), not git staging and not a rendered diff. Nothing is ever auto-approved, no file is ever hidden from the listings, and the reviewer's verdicts survive reloads even when accepting staged the hunk out of the diff.

## Operating Context

- Runs locally, next to the repo under review, in the developer's own agent session. The desk is a browser tab on the same machine by default.
- **Four review modes**, chosen at start: `repo` (working-tree diff; `--diff staged` for the index; `--path` to narrow), `file` (one file or artifact, tracked or not — a generated plan, PRD, issue), `pr` (a branch's commits vs merge-base, by branch name, PR number, or GitHub URL).
- **The agent attaches** through CLI subcommands (`await`, `comment`, `status`, `reload`, `stop`) over HTTP, or through the pi tool `syneva_agent`, which routes questions to a dedicated read-only correspondent thread and wakes the owning session only for completed reviews, closed desks, and correspondent failures.
- **Between rounds**: the human keeps one tab across rounds (start is idempotent, each repo+session binds a stable port, so a restarted desk self-heals the open tab). The agent edits between rounds and calls `syneva reload` — anything it touches resets to pending; anything untouched carries over.
- **Grouped review**: the agent may attach a guide — a reading order plus a category per file — which turns the Walkthrough tab into domain sections (general → specific). It is a grouping only, carrying no prose and no flags; files the guide doesn't list land in a trailing **Other** section, and the reviewer's decisions, comments and Send are unaffected by it.
- Distributed primarily as a **pi package** (CLI, `/syneva` status command, `/review` and `/plan` prompt templates, syneva skill, `syneva-answer` subagent); the plain CLI also installs and runs standalone for non-pi hosts.
- **Remote-dev** is supported but explicitly secondary: `--host` / `SYNEVA_HOST` bind the desk wider (e.g. a tailnet) so the human can review from another machine while the agent keeps talking over loopback.
- State lives under `~/.syneva/<repoHash>/<session>/`; display preferences in `~/.syneva/settings.json`. Every save is persisted; a restart restores the session. An idle desk (no tab, no agent) exits after ~2h.

## Capabilities and Constraints

**Capabilities.** Diff rendering built on `@pierre/diffs` with virtualization and a windowed tokenizer; four review modes; per-change accept/reject; whole-file comments from the file header and the guide bar; per-line comment threads with Ask and Request-change intents; question threads the agent answers live; **Send to Agent** producing a structured `ReviewResult` (accepted, rejected, requestedChanges, approval list, staged list, open questions, optional overall note); an agent-supplied review grouping (reading order + category sections); a keyboard-first command map; open-in-editor via a repo-scoped command; display preferences (diff layout, intra-line, hunk separators, wrapping, highlight theme, fonts).

**Committed roadmap** (README, rough priority order — future work should treat these as direction, not re-proposals): a discoverable command palette; `syneva commit <ref>` / `range <base>..<head>` / `branch <base>` review modes; lazy per-file content loading with large/binary-file guards at the data layer.

**Technological and operational constraints.**
- Node 22+ and `git` for the published CLI (Node 24 for repo tooling); the file/PR modes shell out to git.
- `pr` mode needs `gh` installed and authenticated when the ref is a PR number or URL.
- Two compilation worlds that never import each other at runtime: a Node backend (ESM/NodeNext, `dist/backend/bootstrap/cli.js` is the published bin) and a browser UI (Alpine.js, bundled by esbuild), sharing types from `src/contracts/` alone.
- Patch/version convention is upstream-forked: Conventional Commits, `changelogen` release, CI on Node 24.
- MIT licensed.

**Terminology.** desk (the served review surface), reviewer (the human), agent (the attached coding agent), Send to Agent (the handoff), guide (the agent-supplied file grouping: review order and category sections), `ReviewResult` (the handoff payload).

**Explicitly undecided:** no hosted/multi-user mode, no auth model, no telemetry of any kind.

## Brand Commitments

- The name is **Syneva** and its identity is its own: Syneva is a fork of [Galley](https://github.com/ymansurozer/galley) by Yusuf Mansur Özer, credited as the origin in the README and LICENSE, not as a live upstream to keep tracking. Divergence is free.
- The term **integrated review environment (IRE)** is the product's own category phrasing, used in the description and README.
- **Voice**: first-person, direct, opinionated, low-hype. The README states what the tool believes and admits its limits ("I built it in a week and I'm still figuring out the shape"). Future copy should read that way — no marketing register, no invented authority.
- No binding colour, type, or imagery commitments were established.

## Evidence on Hand

- The working tool itself: a runnable CLI + browser desk, a documented machine contract printed by `syneva spec`, and a test suite covering that contract.
- Upstream provenance: the fork's origin is real and creditable.

**Absences future work must not fabricate:** no user testimonials, no case studies, no adoption or performance benchmarks, no press, no customer logos, no usage metrics. Syneva has no external user base to cite, and upstream Galley's public history is not Syneva's track record.

## Product Principles

1. **The review surface is the whole product.** Syneva does not call models, orchestrate agents, or host anything. Every feature must be about seeing, judging, and handing off a diff.
2. **The human's review is the authority.** Verdicts are explicit and recorded; nothing is auto-approved; a grouping reorders and labels files but can never hide one (the guide's unlisted files get their own trailing section); a rewritten change resets to pending rather than silently keeping a stale verdict.
3. **Bring your own agent.** The contract stays plain, documented, and vendor-neutral; the ceiling on what an agent can do in the desk is set by the user's agent, not by Syneva.
4. **Local and private by default.** Loopback binding, no telemetry, stable per-session origin; widening the bind is an explicit, warned opt-in. Syneva never edits tracked files — the agent does that, on the reviewer's verdicts.
5. **Friction is the enemy of the loop.** One tab, one stable origin, decisions that survive reloads, a keyboard-first path through the whole review: anything that costs a round-trip or a re-orientation is a defect.

## Accessibility & Inclusion

The bar is **practical, not formal**: a keyboard-first command map (every major action reachable without a mouse), legible functional text, and honest contrast in both light and dark display modes. No WCAG level is committed and no formal audit is required; legibility and reachability of the review actions are treated as product quality, not optional polish.
