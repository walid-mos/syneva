<div align="center">

# Syneva

**An integrated review environment (IRE) for code you didn't write by hand.** Fork of [ymansurozer/galley](https://github.com/ymansurozer/galley), packaged as a pi package.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<img src="assets/screenshot.png" alt="Syneva — a guided review: pending changes with accept/reject, a question waiting on the agent, and a change request" width="80%" />

</div>

<br>

Code editors and IDEs were built for a coding-first world. Their diff view is fine for a quick glance, but not for working through a big change or going back and forth with the agent that wrote it.

Syneva is my attempt at a real review surface: you review, hit **Send to Agent**, and your agent acts on your decisions and replies in place.

I'm not saying this is *the* review surface. I built it in a week and I'm still figuring out the shape. But this is what I think it should be.

## Getting started

1. **Install as a pi package** (ships the CLI, a `/syneva` status command, `/review` and `/plan` prompt templates, and a syneva skill):

   ```bash
   pi install git:github.com/walid-mos/syneva@<ref>   # pinned git install
   # or point settings at a local checkout: pi install /absolute/path/to/syneva
   ```

   Outside pi, the plain CLI still works: `npm install -g syneva` (needs **Node 22+** and **git**).

2. **Start a review:**

   ```bash
   syneva                       # review the working-tree diff
   syneva --diff staged         # review the staged diff
   syneva file path/to/plan.md  # review a single file or artifact (e.g. a generated plan)
   syneva pr feature-branch     # review a branch's commits vs its merge-base
   ```

   Syneva opens in your browser and stays open. You review and click **Send to Agent**; the agent attaches, acts on each send, and replies in the same tab. The full agent contract — modes, the event loop, all flags (`--repo`, `--path`, `--port`, `--no-open`, `--guide`, …), `ReviewResult`, and the guided-review schema — is printed by **`syneva spec`**.

### Reviewing on a remote machine

By default the desk binds to `127.0.0.1` — loopback-only, unreachable from any other device. For a remote-dev setup (the agent and desk run on a server, you review from a browser on your laptop), `--host` binds it wider:

```bash
syneva --host 0.0.0.0                 # bind all interfaces; prints a hostname-based URL to open
syneva --host 100.64.1.5              # bind one specific address (e.g. a tailnet IP)
SYNEVA_HOST=0.0.0.0 syneva            # same, via env — the default when --host is absent
```

The printed URL is what you open in the remote browser; the agent's `syneva await`/`comment`/`reload` subcommands keep talking to the desk over loopback on the same machine, so they're unaffected. If you reach the desk by a name that isn't the machine's hostname or the bound address (a tailnet MagicDNS FQDN, say), add it to `SYNEVA_ALLOWED_HOSTS` (comma-separated) so the origin guard accepts it.

> [!WARNING]
> **The desk API is unauthenticated.** Anyone who can reach the bound address can drive the desk — run your configured editor command, stage and reset changes, mutate the git index, read any file in the repo. Bind beyond loopback **only** on a fully trusted network: a personal tailnet, or a host whose firewall blocks the port from everything else. **Never on a shared office/coffee-shop LAN.**

## Features

- **A beautiful and functional diff view** built on `@pierre/diffs`.
- **Per-line comment threads.** Comment on any line. Ask questions — as many as you like, without waiting — and your agent answers live in the thread; leave a change request and it rides to the handoff.
- **Whole-file comments.** The file header (and the guide bar's 💬 button) opens a thread addressed to the file itself — same Ask / Request change intents. A file-wide change request keeps the file out of Approved until it's resolved.
- **Per-change accept/reject.** Accept or reject individual changes, or sign off a whole file.
- **A tight handoff loop.** Hit **Send to Agent** and your agent gets a structured review. It makes the edits, re-diffs into the same tab, and replies in place.
- **Guided review.** Your agent can attach a guide: an overview, the files in a sensible order, a per-file orientation (the lens to read it with) and category, and the risky ones flagged.
- **Focused review.** Ask your agent to skim the noise ("ignore the import churn") and the guide marks it: skimmed changes collapse behind one-line strips, and files that are pure noise leave the flow entirely — folded into a Skimmed group, with no progress weight. Everything stays one click from visible, and nothing is ever auto-approved.
- **Four review modes.** The working tree, the staged diff, a single file (tracked or not, like a plan, PRD, or issue — markdown renders, with the file's own images served straight from the repo), or a branch against its merge-base.
- **Keyboard-first.** Intuitive navigation: move by file, line, or change, and accept, reject, comment, or approve without touching the mouse.
- **Open in editor.** Configure a repo-scoped editor command and jump from the review desk to the current file and line.
- **Customize** diff layout, intra-line, hunk separators, wrapping, code-highlight theme, and fonts.

## Principles

Syneva is opinionated about exactly one thing: the review surface. It's a protocol and an interface, nothing more. How you review, and what you review with, stays yours.

- **No model runs here.** Syneva doesn't call an LLM or orchestrate one. It renders the diff, validates the structured input it's given, and hands a result back.
- **Your agent, not ours.** The contract is plain JSON over stdout and a localhost server, with no assumption about who's on the other end: Claude Code, Cursor, Codex, a shell script. The guided review, the answers to your questions, the code changes themselves are all *your* agent's work. Syneva just gives it somewhere to land.
- **Local and private.** The server binds to loopback (`127.0.0.1`) on a stable per-session port. No telemetry. Your browser may fetch a web font; switch to system fonts and even that stops. (For remote-dev setups, `--host` can bind it wider — see [Reviewing on a remote machine](#reviewing-on-a-remote-machine); the default stays loopback-only.)
- **It won't touch your repo unless you ask.** Syneva never edits your tracked files.

## Roadmap

Immediate to-dos, in rough priority order.

- [ ] **Command palette**: add a discoverable Cmd/Ctrl+Shift+P palette for common review actions: file filter, find in diffs, next/previous file or change, accept/reject/request change, approve file, toggle layout/settings/sidebar, open in editor, reload, and Send to Agent. Keep keyboard shortcuts as the fast path, but make every major action searchable.
- [ ] **Commit/range/branch review modes**: expand beyond working/staged/file/PR branch reviews with `syneva commit <ref>`, `syneva range <base>..<head>` / `<base>...<head>`, and `syneva branch <base>` so Syneva can review historical or comparison diffs without requiring a dirty working tree.
- [ ] **Lazy diff/content loading + large/binary-file guards**: today every changed file's full contents are read and shipped up front; the only large-file handling is client-side render deferral. Move the guard to the data layer: classify each file by byte size and ship lightweight patch data first, hydrating full contents, highlighting, and rendered markdown on demand when a file is opened. Per-file `loadState` (`ready | deferred | too-large | binary | error`) with two byte tiers — an *eager* limit (~1 MiB, loaded up front) and a *manual* limit (~2 MiB, deferred until opened); over that is `too-large` (skipped with a summary + explicit load-anyway action), plus an image byte cap. Add **binary detection** (NUL-byte scan) so binaries are skipped rather than read as UTF-8 and handed to @pierre.

## Acknowledgements

Syneva is a **fork of [Galley](https://github.com/ymansurozer/galley)** by Yusuf Mansur Özer — the review desk, the agent contract, and most of what makes this project good are his work. Thank you for building it and sharing it under MIT.

## License

[MIT](./LICENSE) © Walid Mostefaoui — the original Galley code © Yusuf Mansur Özer
