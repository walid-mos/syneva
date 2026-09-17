---
description: Review the current branch in Syneva — live browser desk, act on the reviewer's sends
argument-hint: "[ref|focused] [focus notes]"
---
Run an interactive code review of a branch through **Syneva** (a browser review desk; the human accepts/rejects changes and clicks Send to Agent, you act and reply in the same tab). The desk stays live across rounds — never treat one send as the end.

Arguments ($@): a branch name, PR number, or GitHub URL to review (default: the current branch via `git branch --show-current`, detached HEAD → ask what to review), optionally the word `focused` (attach a skim-everything-mechanical guided review), and remaining words are focus instructions for the guide. If no argument makes sense, proceed with the default.

Treat **`syneva spec`** as the authoritative contract — run it once before your first Syneva review this session (modes, await/comment/reload loop, ReviewResult, guide schema). `syneva` is installed by the syneva pi package (shim in `~/.pi/agent/bin`); if it is missing, tell the user and offer the upstream fallback `pnpm add -g syneva`.

1. **Pick the mode.** Fixed target is pr mode: `syneva pr <ref>` — the branch's commits vs its merge-base.
   - If `ref` was given explicitly, use it (a non-current branch gets checked out by Syneva; it aborts on a dirty tree).
   - If the working tree is **clean** → go to step 2.
   - If the working tree has **uncommitted tracked changes** (default is to include them in the branch review): ask the user with `ask_user_question`, options:
     a. Commit the changes as one WIP commit (`git add -A` + `git commit -m "wip: …"`), then review the whole branch including it;
     b. Stash the changes, review only the committed branch;
     c. Review only the uncommitted working-tree changes now (`syneva`, repo mode) and skip branch commits.
     Never commit, stash, or checkout without the user's explicit choice.
2. **Compose the guide** from `git diff $(git merge-base <base> <ref>)...` file list and your own reading of the changes (browser files briefly as needed): write guide JSON to `/tmp/syneva-guide-<ref|branch>.json`, OUTSIDE the working tree. Follow the Guide JSON schema in `syneva spec`: non-empty `overview` (what this changeset does and why), one `files[]` entry per changed file with `path`, `orientation` (the lens to read it with — role, what to scrutinize; not a changelog) and a `category`; `order` matters least-only; `flag` genuinely risky files with a note. With `focused`: set `focused: true`, skim whole-file lockfiles/generated/vendored/snapshots, `skimBlocks` import-only/formatting-only/mechanical-rename blocks, apply the spec's churn policy — never skim logic or your own risky changes. A validation violation aborts the launch naming the field — get the shape right.
3. **Start the desk in the background** and capture the startup URL:
   ```bash
   rm -f /tmp/syneva-<slug>.log; nohup syneva pr ${1:-$(git branch --show-current)} ${focused:+--guide /tmp/syneva-guide-...} > /tmp/syneva-<slug>.log 2>&1 &
   url=""; for _ in $(seq 1 40); do url=$(grep -m1 -o 'http://[^ ]*' /tmp/syneva-<slug>.log); [ -n "$url" ] && break; sleep 0.25; done; echo "${url:-no URL after 10s - read /tmp/syneva-<slug>.log}"
   ```
   Adjust the command line to the decisions above (e.g. repo mode `syneva` with the guide file). Report the printed URL to the user.
4. **Attach the owning Pi session** with `syneva_agent` as documented in `syneva spec`, then return control. Never delegate waiting to a one-shot subagent. If the tool is unavailable, report the missing native attachment rather than claim the desk will wake an idle agent. Incoming native messages point to the complete event JSON; read it before handling the event:
   - `question` event: answer **each** question in the `questions[]` array — read-only answering: gather context, reply at path/lineNumber/side with `syneva comment`; NEVER edit repo files for a question unless its own text asks for a change (then edit between rounds + `syneva reload`). Long work → post `syneva status --body "…"` progress lines.
   - `review` event: act on the ReviewResult one item per path, don't mix: `rejected` → revert that change; `requestedChanges` → make the edit at path/lineNumber; `accepted`/`approvedFiles`/`stagedFiles` → leave alone; `openQuestions` → answer each read-only first. In pr mode edits are amendments to the branch commits, not working-tree edits — do it, then `syneva reload` to re-diff into the same tab. For anything ambiguous (conflicting verdicts, outside-scope change), ask the user in chat.
   - After handling any event, return control: the native listener remains attached and delivers further events automatically. Keep posting `status` lines through long work.
5. **End state.** `syneva reload` after your edits against the re-checks if the reviewer requested tests; keep looping until the human approves everything or says done. When the review is over: detach with `syneva_agent`, then run `syneva stop` (idempotent) and summarize in chat: approvals left, changes applied, branch state.
