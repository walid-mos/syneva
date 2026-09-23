// The machine contract for driving Syneva as an agent. This is the SINGLE SOURCE OF TRUTH,
// printed by `syneva spec` so an installed skill / AGENTS.md can fetch it at runtime instead
// of hardcoding a copy that drifts from the user's installed binary. It covers the full
// operational contract: review modes, the await/comment/reload loop, await exit semantics, the
// ReviewResult shape, how to act on a review, the guided-review schema, reload-vs-restart,
// concurrency, settings, and errors. Bootstrap-only material (what Syneva is, when to use it,
// how to install it) lives in the skill/AGENTS.md, because you need it before running this.
//
// Written to be dense - every line carries a distinct fact. Keep it in sync with reality: if
// you change CLI flags, events, or the ReviewResult shape, update this string in the same
// change. The spec, CLI, and HTTP tests guard it.
export const SPEC = `syneva agent contract

Syneva serves a localhost browser desk over a git diff. A human accepts/rejects changes,
comments, and asks questions, then clicks Send to Agent; the desk stays live across rounds. You
attach via CLI subcommands - receive each Send, answer questions, post replies that appear live,
and re-diff your edits into the same tab. No model runs in the desk; the review is the human's.

## Review modes
Pick one at start. await/comment/status/reload auto-target the lone live desk and omit --session
below; --session at start (and restart) names the desk - needed only for a stable id or a second desk.
- repo (default) - \`syneva\`: working-tree diff; \`--diff staged\` for the index; \`--path <p>\`
  limits to a path. Untracked (new) files show as full-file additions. Approve stages the file
  (toggle); accept/reject are verdicts. A moved file stages both its old and new paths as a rename.
- file - \`syneva file <path>\`: one file, tracked or not. Unchanged → full file; changed → diff
  (stageable); untracked → full file, verdict-only. Markdown gets a Rendered/Source toggle -
  comment any rendered block. Use it to review an artifact (e.g. a generated plan).
- pr - \`syneva pr <ref>\`: a branch's commits vs merge-base. <ref> = branch | PR number | GitHub
  URL (number/URL resolved via \`gh\`, which must be installed+authed). Checks out the branch
  (aborts if the working tree has uncommitted tracked changes); \`--base <ref>\` overrides the
  base. Verdict only: Approve = approve, reject = request-changes, no staging - you amend the
  branch and re-review.
ReviewResult.mode (repo|file|pr) tells you how to read verdicts.

## Pi attachment (preferred when syneva_agent is available)
Start the desk, then call the Pi tool \`syneva_agent\` with
\`{action:"attach", repo:"<absolute repo>", session:"<desk session>"}\` from the owning
persistent session. Return control: completed reviews, closed events, and failed question
answers wake this same session via native follow-up messages, each pointing to a complete
saved JSON event. Read that file, handle its kind as below, then return control again. Do
not run the CLI wait loop while attached.
Never delegate waiting to a one-shot subagent: its exit cannot wake an idle parent indefinitely.
The listener survives agent turns and restores on reload/resume of the SAME Pi session; a fork
cannot inherit it. Print/JSON sessions cannot attach. Keep the owning Pi process open.
\`syneva_agent {action:"status"}\` reports the connection; transport failures are reported and
require reattachment. Before switching desks, detach with
\`syneva_agent {action:"detach"}\` - the browser Close already does it (see closed); detach
does not stop the desk. Use \`syneva stop\` separately.

### Question routing - the desk correspondent answers, the owner reviews
The extension runs ONE deterministic correspondent thread per desk: a \`pi -p\` process rooted
in the repo with a fixed session file (\`<reviewDir>/correspondent-session.jsonl\`), read-only
tools, no extensions, no inherited listener. That thread is 1 thread = 1 agent: it resumes the
same conversation for every question and keeps the review Q&A context THERE, not in the owner
session, which is never asked to read for an answer. On each question event the extension
spawns that thread with the saved event file, parses its "### q<N>" reply blocks, and posts
each answer to the desk at the question's own path/line/side with role agent, VERBATIM - no
owner turn, no per-question children, no runs.all fanout. The owner is woken only for review
events (act on the feedback in the owner, which holds the code context, then \`syneva reload\`),
closed events, and a correspondent failure, in which case it answers the questions itself with
\`syneva comment\`, VERBATIM at the saved anchors. Never fork the owner transcript for a
factual question: a fork re-sends exactly what the routing exists to avoid.

For an existing unattached desk, attach the session that owns its review context, not an unrelated
agent. If the tool is missing in an already-open Pi process, reload the Pi extensions first.

## The loop (CLI-only hosts, without the Pi attachment)
Start the desk in the background, then await events and branch on kind:
\`\`\`bash
syneva --session <id> --diff working &
while ev=$(syneva await); do
  [ -z "$ev" ] && continue                               # --timeout fired, no event
  case "$(jq -r .kind <<<"$ev")" in
    question)  # answer EACH - READ-ONLY (see Events); thread under each question's path/line/side
      jq -c '.questions[]' <<<"$ev" | while IFS= read -r q; do   # one object per line - space-safe
        syneva status --body "Reading X to answer…"        # live progress
        syneva comment --path "$(jq -r .path<<<"$q")" \\
          --line "$(jq -r .lineNumber<<<"$q")" --side "$(jq -r .side<<<"$q")" --body "…"
      done ;;
    review)    # act on the ReviewResult, then \`syneva reload\` to show your edits
      r=$(jq .result <<<"$ev") ;;
    closed)    exit 0 ;;    # the human ended the review in the browser - workflow over
  esac
done
\`\`\`
- \`syneva await [--timeout <s>]\` - block for the next event, print one tagged JSON envelope,
  exit. No --timeout → holds open; --timeout <s> → empty stdout (204) after <s>s, re-poll. Exit
  non-zero = no live desk (start one) - including a desk that went silent mid-poll (closed or
  crashed; don't blind-restart a closed desk, see the closed event below). After handling ANY
  event, await again immediately - more
  may already be queued (the human keeps working while you act).
- \`syneva comment --path <f> --line <n> [--side additions|deletions] --body "…"\` - agent reply.
  Live desk → posts over HTTP (~1.5s), threaded under the matching human comment; no desk →
  appended to the saved review. Match path/line/side. Agent comments are never echoed back as
  requestedChanges.
- \`syneva status --body "…"\` - ephemeral one-line "doing X now" beside the reviewer's spinner.
  Cleared by your next comment; stale after ~90s (keep posting through long work); never
  persisted; exits 0 even with no desk.
- \`syneva reload [--guide <file>]\` - re-diff the working tree into the live desk (your edits are
  NOT auto-re-diffed). Anything you edit resets to pending on reload - decisions and approvals
  alike; anything you left untouched carries over. --guide swaps the grouping (one desk only -
  see Between rounds).
- \`syneva stop [--session <id> | --all]\` - shut down this repo's live desk(s) (--all = every
  session). Idempotent, exits 0 with {stopped:[…]} whether or not a desk was running - call it
  yourself the same turn the session settles; never ask the human whether to stop, that prices
  an idle desk's closure at a whole LLM round-trip. The human's browser Close is the same
  shutdown, delivered to you as a closed event. All review state is persisted; a later
  start restores the session.

## Events
await yields exactly one:
- {"kind":"question","question":{path,lineNumber,side,body,mode,session},"questions":[…]} -
  reviewer wants an answer NOW. \`questions\` holds every question batched into this delivery
  (arrival order; \`question\` is the oldest, kept for compatibility) - answer EACH, and on a Pi
  attachment answer each in its own read-only child, never in the owner session (see Question
  routing). A question wants
  an ANSWER, not a code change: answering is READ-ONLY - read for context, reply with \`syneva
  comment\` at path/lineNumber/side, and NEVER edit tracked files (the "Between rounds" rule) unless
  the question's own text asks for a change (then edit + \`syneva reload\`). lineNumber 0 (anchor
  "file") = a whole-file question asked from the file header - reply with \`syneva comment --path
  <f> --line 0 --body "…"\`. Questions are a live side-channel - never in a Send/ReviewResult
  except openQuestions below. Slow answer → post \`syneva status\` lines so the human sees progress.
- {"kind":"review","result":{…ReviewResult…}} - reviewer clicked Send. Act on result.
- {"kind":"closed","session":...} - the reviewer ended the review from the browser (the desk's
  Close, ⇧Q). The desk exits right after emitting it, so no await will ever answer again: end
  your round and DON'T restart the desk yourself (relaunch/reattach only when the human asks).
  A Send queued but never picked up live still left artifacts.resultJson (file-poll fallback);
  all review state is saved, and a later \`syneva --session\` restores it. A Pi attachment deals
  with closed internally - it auto-detaches and notifies the session.

## ReviewResult
The \`result\` field of a review event:
- session, repoRoot, mode, staged, head (sha|null), baseDiffHash (hash of the reviewed diff)
- accepted[], rejected[]: {path, lineNumber, side, title}
- requestedChanges[]: {path, lineNumber, side, body} - the edit to make per request (lineNumber 0
  + anchor "file" = a whole-file request from the file header: apply it to that file as a whole).
- overallNote? - optional note about the WHOLE review (absent if blank): an overall remark, or an
  afterthought instruction for after applying (e.g. "run the formatter"). Not tied to any line.
- stagedFiles[], approvedFiles[]
- openQuestions[]: {path,lineNumber,side,body,mode,session} - questions you never answered, folded
  into this Send (superseding queued live question events). Answer each with \`syneva comment\`
  (READ-ONLY, as a live question) while acting on the round.
- artifacts: {resultJson, sessionDir} under ~/.syneva/<repoHash>/<session>/ (repoHash =
  sha256(abs repo root)[:16])
The arrays above ARE the review - act on them directly; there's no prose summary to parse.
Each changed file ends pending | approved (no objections → listed in approvedFiles) |
changes-requested (a rejected hunk and/or a requested change).
File-poll fallback (can't hold a long-poll / background the desk): every Send (over)writes the same
ReviewResult to artifacts.resultJson - watch sessionDir, read the newest *-result.json (new mtime =
new Send). Live questions arrive only via await, so a file-poller sees Sends but not Asks.

## How to act on a review - one path per item, don't mix
- rejected → revert that change; the reviewer doesn't want it.
- requestedChanges (a comment) → make the edit at path:lineNumber; lineNumber 0 (anchor "file")
  = a whole-file request - apply it to that file as a whole, wherever it belongs.
- accepted → leave it; don't re-touch.
- approvedFiles → signed off as-is; leave the whole file unless a requested change forces a touch
  (which re-opens it for re-review).
- stagedFiles → already staged by the reviewer; don't touch unless a requested change requires it.
In pr mode the diff is committed changes: amend the branch/commits to apply the review, leaving
approved hunks as-is (rather than editing the working tree).
Then \`syneva reload\` to surface your edits. With the Pi attachment, return control; otherwise
run \`syneva await\` for the next round. When the round is fully handled and nothing needs the
reviewer's eyes anymore (no edits awaiting re-review, no open questions - e.g. a clean
all-approved send already committed to an empty diff), call \`syneva stop\` in the same turn:
never end a round by asking the human "say done to stop" - that buys an idle desk with one
whole LLM round-trip for nothing.

## Grouping the review (optional)
By default the desk lists the changed files in diff order. Attach a grouping with
\`syneva <mode> --guide <file>\` to give the reviewer a reading order and domain sections in the
Walkthrough tab (schema below). Syneva validates + renders it and runs no model - order and labels
are yours. Write the guide OUTSIDE the working tree (temp or gitignored): working mode surfaces
untracked files, so an in-repo guide shows as a stray addition. It is a grouping, not a review: it
carries no prose, and the reviewer's decisions, comments and Send are unaffected by it. Stamped to
its diff and surviving reload/restart; once a reload advances past it the desk notes the grouping
may be out of date - regenerate and swap via \`syneva reload --guide <new>\` (one desk only - see
Between rounds). A guide is optional: without one the desk reviews the diff in file order.

### Guide JSON schema
One JSON object:
- files (required, non-empty array) - one entry per reviewed file:
  - path (required, non-empty) - repo-relative.
  - category? - the Walkthrough section this file is listed under (default "Changes"). Files
    group by adjacency in review order, so a label repeated non-adjacently makes a second
    section - keep a category's files together.
  - order? - ascending review order; defaults to array position.
Every other key is ignored, so a guide written for an older Syneva still attaches. Files the guide
doesn't list land in a trailing "Other" section, so nothing is hidden from the reviewer.

Validation: an unreadable file, invalid JSON, a missing/non-array/empty \`files\`, or an entry
without a non-empty \`path\` aborts the launch naming the offending field.

## Between rounds - reload vs restart, and the desk lock
- Don't edit tracked files mid-round: the reviewer wouldn't see the edits and their in-flight
  decisions would be invalidated. Edit between rounds, then \`syneva reload\`.
- Full restart (Ctrl-C, then \`syneva --session <id>\`) is only for changing the diff source
  (working ↔ staged) or the mode.
- A live desk writes <sessionDir>/desk.lock (with its url) and removes it on exit; trust a lock
  only if the server actually answers. The lock url is always loopback-reachable, so your
  subcommands work unchanged even when the desk is bound beyond loopback (--host <addr> /
  SYNEVA_HOST, for remote-dev - the browser url printed at start differs then; operator concern,
  not yours).
- A desk with no open tab and no attached agent for 2h auto-exits (--idle-timeout <min> at start
  overrides; 0 = never). An in-flight await pins it alive. Nothing is lost - state persists on
  every save and a restart reopens the session on the same port, so the old tab self-heals.
- The reviewer keeps ONE tab across rounds: start is idempotent (a live desk is reused, never
  duplicated) and each repo+session binds a stable port, so a restarted/crashed desk reattaches
  to the same origin and the open tab self-heals within seconds - don't tell the reviewer to
  switch tabs. Pass explicit --session/--port only to run a second, separate desk.

## Browser state & refresh
- GET /api/state returns BrowserReviewState plus transient desk status and serverInstanceId, not
  the persisted ReviewState. POST /api/reset returns the same browser projection in its state field
  plus serverInstanceId outside it, and takes { scope: "review" | "approved" | "all" }: 'review'
  clears every decision and sign-off but keeps the notes (comments), 'approved' resets only the
  signed-off files, 'all' - also the default for a bodyless POST - clears the notes too. The tab
  checks the instance on both state-adoption paths.
  rawDiff, per-file hunks, and backend-only metadata never ride these responses. Files carry
  hasHunks and added/removed counts; contents still load separately via /api/file-contents.
- GET /api/poll?instance=<serverInstanceId> normally carries hash, guide, comments and liveness.
  After a desk restart, a mismatched instance receives {kind:"refresh",…liveness} instead. The tab
  shows a persistent refresh-required notice, never automatic navigation, and stops adopting the
  restarted desk's state. Finish pending actions and copy unsaved text before manually refreshing.
  The normal heartbeat without an instance stays compatible.
- Tabs predating this refresh mechanism need one manual page refresh on their first upgrade.
  This browser-only event does not alter syneva await, ReviewResult, or legacy save-body tolerance.

## Settings & errors
- The human's display prefs live in a desk panel (persisted to ~/.syneva/settings.json) - you
  don't set them. Note: with "Approve stages file" OFF, approving is verdict-only and stagedFiles
  may be empty even for approved files. The "Open in editor" command ({repo}/{file}/{line}
  placeholders; known GUI editors only) has no effect on review state.
- Error responses are {error, code, fix, docs} - honor fix. PATCH_CONFLICT (409) = the working
  tree changed since the desk loaded; reload state and retry.`
