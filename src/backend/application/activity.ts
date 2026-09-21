import { nowIso } from './time.js'

import type { AgentActivity } from '../../contracts/browser.js'

// The `syneva status` line is a one-liner; anything longer is a client bug, not a message.
export const MAX_ACTIVITY_CHARS = 200

export type DeskActivity = {
	set(body: string): void
	clear(): void
	read(): AgentActivity | null
}

// Ephemeral "what the agent is doing now" line (`syneva status`). Lives only in this process -
// never on `state`, which persistReview serializes verbatim. Staleness is checked on read (no
// timers): a crashed agent's last line must not show as live activity forever. An agent comment
// clears it - the reply the reviewer waited for has landed, so the line is obsolete.
export function createActivity(ttlMs: number): DeskActivity {
	let line: AgentActivity | null = null
	return {
		set(body: string): void {
			line = { body: body.slice(0, MAX_ACTIVITY_CHARS), at: nowIso() }
		},
		clear(): void {
			line = null
		},
		read(): AgentActivity | null {
			if (line && Date.now() - Date.parse(line.at) > ttlMs) line = null
			return line
		},
	}
}
