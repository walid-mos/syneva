import { fromDisplayLine } from './changes'
import { render } from './render'
import { activeViewport } from './render/viewport'
import { $, S } from './store'

import type { Side } from './types'

// ── Inline composers ─────────────────────────────────────────────────────────
// The composer is imperative DOM built into the diff (like the thread), NOT the old
// floating Alpine popover: a new comment is a `composer` annotation at the selected line,
// a reply is a card at the bottom of its thread, an edit swaps a message body in place.
// Exactly one is open at a time. Its text lives in S.composerBody (synced on input) so it
// survives render()'s rebuild of the diff DOM; caret + focus are restored after each render
// (restoreComposerFocus). The active textarea always carries `.js-composer-focus`.

const SETTLE_TIMEOUT_MS = 200

// Caret offset in the open composer, kept alongside S.composerBody so a rebuild can restore
// the insertion point, not just the text. Reset whenever a composer opens.
let composerCaret = 0
let needsWindowFocus = false

// Sync the store from the live textarea on every keystroke - the store is the source of
// truth a re-render re-mounts from.
function trackInput(ta: HTMLTextAreaElement): void {
	ta.addEventListener('input', () => {
		S.composerBody = ta.value
		composerCaret = ta.selectionStart
	})
	// A click/arrow inside the textarea moves the caret without an input event.
	const syncCaret = (): void => {
		composerCaret = ta.selectionStart
	}
	ta.addEventListener('keyup', syncCaret)
	ta.addEventListener('click', syncCaret)
}

function composerCard(
	cardCls: string,
	inputCls: string,
): { card: HTMLElement; ta: HTMLTextAreaElement } {
	const card = document.createElement('div')
	card.className = cardCls
	const ta = document.createElement('textarea')
	ta.className = inputCls
	ta.value = S.composerBody
	trackInput(ta)
	card.appendChild(ta)
	return { card, ta }
}

// Wire the class-named buttons in a composer row to their handlers. The row markup is static,
// so a missing button is a bug in this module's own HTML, not a runtime condition.
function wireButtons(
	row: HTMLElement,
	handlers: Record<string, () => void>,
): void {
	for (const [cls, handler] of Object.entries(handlers)) {
		const btn = row.querySelector<HTMLButtonElement>(`.${cls}`)
		if (btn) btn.addEventListener('click', handler)
	}
}

// The new-comment / reply composer card: textarea + the two intent buttons (Ask / Request
// change), in the same card family as a message. Used both as its own annotation (new
// comment) and appended to a thread (reply).
export function buildComposer(): HTMLElement {
	const { card } = composerCard(
		'composer-card',
		'composer-input js-composer-focus',
	)
	const row = document.createElement('div')
	row.className = 'crow'
	row.innerHTML = `<span class="spacer"></span><button class="cbtn ask">Ask <kbd>⌘⇧↵</kbd></button><button class="cbtn req">Request change <kbd>⌘↵</kbd></button>`
	wireButtons(row, {
		ask: () => S.ask?.(),
		req: () => S.requestChange?.(),
	})
	card.appendChild(row)
	return card
}

// The in-place edit state for a message: the body swaps for a textarea (amber accent) with
// Save / Cancel, keeping the existing S.editingCommentId + submitComment edit path.
export function buildEditor(): HTMLElement {
	const { card } = composerCard('msg-edit', 'composer-edit js-composer-focus')
	const row = document.createElement('div')
	row.className = 'crow editrow'
	row.innerHTML = `<span class="spacer"></span><button class="cbtn cancel">Cancel</button><button class="cbtn req save">Save <kbd>⌘↵</kbd></button>`
	wireButtons(row, {
		cancel: () => closeComposer(),
		save: () => S.saveComment?.(),
	})
	card.appendChild(row)
	return card
}

// Is the open new/reply composer targeting this (raw) line? S.selected is display space on
// the diff (and identity in the markdown view, where D.lineMap is null), so convert before
// comparing against a thread's raw anchor.
export function composerTargets(side: Side, rawLine: number): boolean {
	return (
		S.composerOpen &&
		!S.editingCommentId &&
		S.selected.side === side &&
		fromDisplayLine(S.selected.side, S.selected.lineNumber) === rawLine
	)
}

// Open a fresh new/reply composer at the current S.selected line (a reply first points
// S.selected at the thread's anchor). The composer appears on the next render.
export function openComposer(): void {
	composerCaret = 0
	S.composerBody = ''
	S.editingCommentId = null
	S.composerOpen = true
	needsWindowFocus = true
	activeViewport()?.reveal(S.selected.side, S.selected.lineNumber, 'center')
	void render()
}

// Close whatever composer is open and rebuild the diff so its DOM goes away (the inline
// composer is imperative - nothing hides it reactively like the old Alpine popover did).
// `isDeferred` postpones the rebuild until the in-flight click has fully settled: the
// outside-click close fires on pointerdown (capture), but the browser only dispatches
// `click` after pointerup - ~50-150ms later for a human press - and any render in between
// destroys the press's mousedown target (a Keep/Undo/Reply button), silently dropping the
// click. A macrotask timer is NOT enough (it fires while the button is still held), so wait
// for the click itself to bubble to the document, with a timeout fallback for pointerdowns
// that never become clicks (drags). If that same click opened a fresh composer (clicking
// another line), the render simply draws it - state is untouched here.
export function closeComposer(isDeferred = false): void {
	S.composerOpen = false
	needsWindowFocus = false
	S.editingCommentId = null
	if (!isDeferred) {
		void render()
		return
	}
	let timer = 0
	const settle = (): void => {
		clearTimeout(timer)
		document.removeEventListener('click', settle)
		void render()
	}
	timer = window.setTimeout(settle, SETTLE_TIMEOUT_MS)
	document.addEventListener('click', settle) // bubble: runs after the target's own handlers
}

// After every render the diff DOM (and any composer inside it) is rebuilt from scratch, so
// re-focus the open composer and restore its caret from the store. No-op when none is open.
export function restorePendingComposerFocus(): void {
	if (needsWindowFocus) restoreComposerFocus()
}

export function restoreComposerFocus(): void {
	if (!S.composerOpen) return
	const ta = document.querySelector<HTMLTextAreaElement>('.js-composer-focus')
	if (!ta?.getClientRects().length) {
		needsWindowFocus = true
		return
	}
	needsWindowFocus = false
	if (ta.value !== S.composerBody) ta.value = S.composerBody
	ta.focus({ preventScroll: true })
	// Focus only scrolls the diff pane, never the outer page. Unslotted offscreen
	// composers wait for their window to mount before attempting to focus.
	const pane = $('diff').getBoundingClientRect()
	const box = ta.getBoundingClientRect()
	if (box.top < pane.top) $('diff').scrollTop += box.top - pane.top
	else if (box.bottom > pane.bottom)
		$('diff').scrollTop += box.bottom - pane.bottom
	const pos = Math.min(composerCaret, ta.value.length)
	ta.setSelectionRange(pos, pos)
}
