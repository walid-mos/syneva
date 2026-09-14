import { currentFile, toDisplayLine } from './changes'
import { cursorJumpTo } from './cursor'
import { revealLine } from './expand'
import { D, $, requireState } from './store'
import { isUnanchored } from './unanchored'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { Decision, ReviewComment, Side } from './types'

type HunkPart = NonNullable<
	FileDiffMetadata['hunks'][number]['hunkContent']
>[number]

const PREVIEW_MAX = 64
const PREVIEW_HEAD = 63

// ── "Why can't I approve this file?" ─────────────────────────────────────────
// fileObjections gates Approve on rejected hunks and open change-request comments, but
// either can sit far off-screen (or, for an orphaned thread, off the diff entirely). The
// blockers chip in the diff header counts them and opens a jump list, so the reason a
// file reads "Mark reviewed" / changes-requested is always one click away.

export type Blocker =
	| { kind: 'reject'; decision: Decision }
	| {
			kind: 'thread'
			side: Side
			lineNumber: number
			preview: string
			unanchored: boolean
	  }

// Must mirror fileObjections (changes.ts) exactly - the chip count and the button label
// have to agree on what counts.
export function fileBlockers(path: string): Blocker[] {
	const state = requireState()
	const out: Blocker[] = []
	for (const d of state.decisions ?? [])
		if (d.path === path && d.status === 'rejected')
			out.push({ kind: 'reject', decision: d })
	const file = state.files.find(f => f.path === path)
	const groups = new Map<string, ReviewComment[]>()
	for (const c of state.comments) {
		if (
			c.path !== path ||
			c.status !== 'open' ||
			c.role === 'agent' ||
			c.intent === 'question'
		)
			continue
		const key = `${c.side}:${c.lineNumber}`
		const group = groups.get(key)
		if (group) group.push(c)
		else groups.set(key, [c])
	}
	for (const comments of groups.values()) {
		comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
		const [first] = comments
		const preview = first.body.replace(/\s+/g, ' ').trim()
		out.push({
			kind: 'thread',
			side: first.side,
			lineNumber: first.lineNumber,
			preview:
				preview.length > PREVIEW_MAX
					? `${preview.slice(0, PREVIEW_HEAD)}…`
					: preview,
			unanchored: !!file && comments.some(c => isUnanchored(c, file)),
		})
	}
	return out
}

// The rendered part at a raw (hunkIndex, changeIndex), or undefined when the hunk or index is gone.
function partAt(hunkIndex: number, changeIndex: number): HunkPart | undefined {
	return D.fileDiff?.hunks.at(hunkIndex)?.hunkContent.at(changeIndex)
}

// Where a rejected hunk renders now: after replay its block is a context entry at the
// same (hunkIndex, changeIndex), so read the display position straight off the rendered
// diff; fall back to mapping the decision's raw anchor.
function decisionDisplayPos(d: Decision): { side: Side; line: number } {
	const ch = requireState().changes.find(c => c.id === d.key)
	const changeIndex = ch?.changeIndex
	const part =
		ch && typeof changeIndex === 'number'
			? partAt(ch.hunkIndex, changeIndex)
			: undefined
	if (!ch || !part)
		return { side: d.side, line: toDisplayLine(d.side, d.lineNumber) }
	if (part.type === 'change')
		return {
			side: ch.side,
			line:
				(ch.side === 'additions'
					? part.additionLineIndex
					: part.deletionLineIndex) + 1,
		}
	return { side: 'additions', line: part.additionLineIndex + 1 }
}

export function jumpToBlocker(b: Blocker): void {
	if (b.kind === 'thread' && b.unanchored) {
		// The thread lives in the strip above the diff, not on a row.
		const el = $('diff').querySelector<HTMLElement>(
			`.unanchored-strip [data-thread="${b.side}:${b.lineNumber}"]`,
		)
		const strip =
			el ?? $('diff').querySelector<HTMLElement>('.unanchored-strip')
		strip?.scrollIntoView({
			block: 'center',
			behavior: 'smooth',
		})
		if (el) {
			el.classList.remove('flash')
			void el.offsetWidth // restart the animation
			el.classList.add('flash')
		}
		return
	}
	if (b.kind === 'thread') {
		revealLine(b.side, b.lineNumber) // unfold first if the line sits in a collapsed run
		cursorJumpTo(b.side, toDisplayLine(b.side, b.lineNumber))
		return
	}
	const pos = decisionDisplayPos(b.decision)
	cursorJumpTo(pos.side, pos.line)
}

// The header chip + its jump-list popover (imperative DOM, like the rest of the header).
function setRowText(row: HTMLElement, text: string): void {
	const span = row.querySelector('.bk-text')
	if (span) span.textContent = text
}

export function blockersChip(): HTMLElement | null {
	const { path } = currentFile()
	const items = fileBlockers(path)
	if (!items.length) return null
	const wrap = document.createElement('span')
	wrap.className = 'blockers'
	const btn = document.createElement('button')
	btn.className = 'blockers-chip'
	btn.textContent = `${items.length} blocker${items.length === 1 ? '' : 's'}`
	btn.setAttribute('data-tip', "What's keeping this file from Approved")
	wrap.appendChild(btn)
	const pop = document.createElement('div')
	pop.className = 'blockers-pop'
	for (const b of items) {
		const row = document.createElement('button')
		row.className = 'blockers-item'
		if (b.kind === 'reject') {
			row.innerHTML = `<span class="bk-kind reject">Rejected</span><span class="bk-where">line ${b.decision.lineNumber}</span><span class="bk-text"></span>`
			setRowText(row, b.decision.title)
		} else {
			row.innerHTML = `<span class="bk-kind change">Change request</span><span class="bk-where">${b.unanchored ? 'unanchored' : `line ${b.lineNumber}`}</span><span class="bk-text"></span>`
			setRowText(row, b.preview)
		}
		row.addEventListener('click', () => {
			wrap.classList.remove('open')
			jumpToBlocker(b)
		})
		pop.appendChild(row)
	}
	wrap.appendChild(pop)
	btn.addEventListener('click', e => {
		e.stopPropagation()
		const open = wrap.classList.toggle('open')
		if (!open) return
		const close = (ev: MouseEvent): void => {
			if (ev.target instanceof Node && wrap.contains(ev.target)) return
			wrap.classList.remove('open')
			document.removeEventListener('click', close, true)
		}
		document.addEventListener('click', close, true)
	})
	return wrap
}
