---
name: syneva
description: Drive Syneva — a living browser surface where a human reviews a git diff (accept/reject changes, leave comments) and the coding agent acts on their decisions and replies in the same tab. Use after making code changes the user should review, when the user asks to "open the Syneva", or to collaborate on a diff turn-by-turn.
license: MIT
metadata:
  homepage: https://github.com/walid-mos/syneva
---

# Syneva

Syneva is a **living** browser surface for a git diff (working tree or staged). A human reviews the diff — accepting/rejecting changes and leaving comments — and clicks **Send to Agent**. The desk does **not** close on send: it keeps running across rounds. The agent attaches to it, receives each send, posts replies that appear in the open tab live, and the human keeps going in the same tab.

The review is the human's; the agent acts on the decisions and answers questions. No model runs inside the desk.

## When to use it

Reach for Syneva when the user should review something turn-by-turn: **code changes you made** (the working tree or staged diff), **a markdown plan or single artifact**, or **a branch / PR**. Use it when the user asks to "open the Syneva", or whenever a diff is better reviewed interactively than pasted into chat. When the user asks for a **focused review** (mechanical churn — lockfiles, generated code, import churn, moved files — de-emphasized so only the real changes stand out), attach a guide; `syneva spec` documents the focused-review schema.

## Getting the tool

`syneva` is a small Node CLI (Node 22+ and `git` required). To use it across any repo, install it globally: `npm install -g syneva`. To use it in just one project, add it there as a dev dependency (`npm install -D syneva`) and run it with `npx syneva`. Either way, invoke it as `syneva …`.

## Quickstart

Three ways to start a review desk (each runs in the background and stays alive across rounds):

- **Changes you made** → `syneva --session <id> &` (working tree; `--diff staged` for staged only).
- **A markdown plan / single artifact** → `syneva file <path> &`.
- **A branch / PR** → `syneva pr <ref> &`.

Close the desk yourself — once a Send is fully acted on and nothing needs the reviewer's eyes (no edits awaiting re-review, no open questions), run `syneva stop` in that same turn; never end a round asking the human whether to stop, that trades one whole LLM round-trip for an idle desk's closure. `syneva stop` is idempotent and all review state persists for a later restart. An abandoned desk also auto-exits after ~2h with no tab and no agent attached.

## The authoritative contract: `syneva spec`

**For the full contract — review modes, the `await`/`comment`/`reload` loop, `await` exit semantics, the `ReviewResult` shape, how to act on a review, the guided-review schema, reload-vs-restart, concurrency, settings, and errors — run `syneva spec` and follow it.** Do this once per session before your first review.
