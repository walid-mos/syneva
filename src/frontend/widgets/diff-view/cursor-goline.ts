import { diffCtx } from './context'
import { landAt } from './cursor'

// ── Go to line ───────────────────────────────────────────────────────────────
// Typing digits in the diff accumulates a line number (shown as the goline pill); ↵ or a short
// idle pause commits the jump, Esc cancels. Commit only moves the cursor - the existing ↵ /
// ⇧Y / r bindings take over from the landed line, so the jump composes with every verb.
// Split from cursor.ts as its own concern: pure store buffer + commit on the shared landAt.

const GOLINE_COMMIT_MS = 800

let golineTimer: ReturnType<typeof setTimeout> | undefined

export function golineActive(): boolean {
	return !!diffCtx().S.golineBuffer
}

export function golineDigit(d: string): void {
	if (!diffCtx().S.golineBuffer && d === '0') return // a leading 0 can't start a real line number
	diffCtx().S.golineBuffer += d
	clearTimeout(golineTimer)
	golineTimer = setTimeout(golineCommit, GOLINE_COMMIT_MS)
}

export function golineCancel(): void {
	diffCtx().S.golineBuffer = ''
	clearTimeout(golineTimer)
}

export function golineCommit(): void {
	const n = parseInt(diffCtx().S.golineBuffer, 10)
	golineCancel()
	if (!Number.isFinite(n)) return
	// Prefer the additions/new side - the number a reviewer reads off the gutter. No retry:
	// goline never triggers an expansion, so a miss means the line isn't rendered.
	if (!landAt('additions', n))
		diffCtx().toast(`Line ${n} isn't visible in this diff`)
}
