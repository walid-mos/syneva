# extension/ — the harness module

Everything a coding-agent harness loads from this package lives here, in one
module. Today the harness is pi (this package is a pi package; the `pi` key in
`package.json` wires each piece). Later the same contract is exposed as an MCP
server — see "MCP trajectory".

## Layout

| Path | What it is | Loaded by pi as |
|---|---|---|
| `syneva.ts` | The extension entry: keeps the `syneva` CLI shim in `~/.pi/agent/bin`, registers the `/syneva` status command and the `syneva_agent` desk bridge. The only file here that imports `src/` (`src/agent/pi-bridge.ts`). | extension |
| `prompts/plan.md`, `prompts/review.md` | `/plan` and `/review` prompt templates: start a desk, attach, act on events. | prompt templates |
| `skills/syneva/SKILL.md` | The bootstrap skill: what Syneva is, when to reach for it, and the single rule that matters — run `syneva spec` for the authoritative contract. | skill |
| `subagents/syneva-answer.md` | The read-only subagent that answers one review question for pasting into a thread. | subagent |

## Rules

- **Adapter only.** This module contains no business logic. Everything it does
  goes through the CLI/HTTP contract whose single source of truth is
  `src/spec.ts` (`syneva spec`). Change the contract there; the pieces here
  follow.
- **`syneva spec` is the only contract text.** Prompts and the skill must point
  at it, never restate it — duplicated contract details drift.
- The extension entry is a loader seam: it default-exports its register
  function because pi's loader requires it (oxlint override in
  `oxlint.config.ts`).

## MCP trajectory

When Syneva gains an MCP server (`src/mcp/`, wrapping the same desk operations
— start, await, comment, reload, status — as MCP tools over stdio/HTTP), this
module is what survives, mostly unchanged:

- `syneva.ts` shrinks to a thin launcher (or disappears in favor of pi's own
  MCP client configuration); the shim and `/syneva` status go with it.
- `prompts/`, `skills/`, and `subagents/` keep working as-is: they depend only
  on the `syneva` command (which the MCP server wraps) and on `syneva spec`,
  not on pi specifics.
- New harness-facing surfaces belong here, not in `src/`, until they are
  harness-agnostic — that is the signal for moving them into the server.
