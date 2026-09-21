---
description: Plan work and discuss the live plan in Syneva — the human comments on the plan and you answer and revise it in place
argument-hint: "<what to plan>"
---
Plan **$ARGUMENTS** and review the plan interactively through **Syneva**: the plan lands in a browser desk where the human accepts/demands changes and asks questions; you revise the plan live. Iterate until the plan is approved — this command produces a plan, not an implementation.

Treat **`syneva spec`** as the authoritative contract — run it once before your first Syneva review this session (file mode, await/comment/reload loop, ReviewResult). `syneva` is installed by the syneva pi package (shim in `~/.pi/agent/bin`); if it is missing, tell the user and offer the upstream fallback `pnpm add -g syneva`.

1. **Investigate** the repository enough to plan concretely: relevant files, existing patterns, tests/checks, constraints. Do not write code yet.
2. **Write the plan** (English) to `<repo>/.pi/syneva/plans/<slug>.md` where `<slug>` is from the request (kebab-case, ≤40 chars; if the file already exists, suffix `-$EPOCHSECONDS`). `mkdir -p` first. Sections: **Goal**, **Context** (what exists, relevant constraints), **Approach** (steps with rationale, in order), **Files touched** (per file: what changes and why), **Risks / open questions**, **Verification** (how each step proves done). If the repo has AGENTS.md/CLAUDE.md, honor it.
3. **Keep the plan invisible to git**: if in a git repo and the path is not already ignored (check `git check-ignore -q .pi/syneva/plans/<slug>.md`), append one line `.pi/syneva/plans/` to `.git/info/exclude` (never touch tracked `.gitignore` for this).
4. **Start the desk in the background** (file mode):
   ```bash
   rm -f /tmp/syneva-<slug>.log; nohup syneva file .pi/syneva/plans/<slug>.md > /tmp/syneva-<slug>.log 2>&1 &
   url=""; for _ in $(seq 1 40); do url=$(grep -m1 -o 'http://[^ ]*' /tmp/syneva-<slug>.log); [ -n "$url" ] && break; sleep 0.25; done; echo "${url:-no URL after 10s - read /tmp/syneva-<slug>.log}"
   ```
   Report the printed URL to the user.
5. **Attach the owning Pi session** with `syneva_agent` as documented in `syneva spec`, then return control. Never delegate waiting to a one-shot subagent. If the tool is unavailable, report the missing native attachment rather than claim the desk will wake an idle agent. Incoming native messages point to the complete event JSON; read it before handling the event:
   - `question` event: read-only answering — comment replies at path/lineNumber/side, no file edits, no implementation chatter. Long work → `syneva status --body "…"`.
   - `review` event: the plan was judged — `requestedChanges[]` → **edit the plan file** at those points between rounds (this file is the artifact edit target; never repo code); `rejected[]` → remove/rework those parts; `accepted`/`approvedFiles` → keep; `openQuestions[]` → answer read-only first. Regenerate/annotate the plan file, then `syneva reload` so the desk re-reads it in the same tab.
   - After handling any event, return control: the native listener remains attached and delivers further events automatically. Continue until **the plan file is approved** (every section approved by the reviewer) or the human says done.
6. **On approval**: post one `syneva comment` summarizing the agreed approach (2–4 sentences), tell the user in chat the plan is approved with the path of the file, and **keep the desk open** for further rounds — do not start implementing until the user explicitly asks. Detach with `syneva_agent` and run `syneva stop` only when the human says the review session is over.
