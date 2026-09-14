import { confirmYes } from './confirm'
import { golineCancel } from './cursor'
import { cmd, enter } from './hotkey-matchers'
import { HOTKEYS_APP } from './hotkeys-app'
import { HOTKEYS_DIFF } from './hotkeys-diff'
import { S } from './store'

import type { Group, Hotkey } from './hotkey-matchers'

// ── Central keyboard map ─────────────────────────────────────────────────────
// One ordered table is the single source of truth: the dispatcher runs the first binding whose
// key matches and whose scope is active, and the ? help overlay renders from the same table - so
// hints can never drift from behavior. Scopes keep a key meaning the right thing in context.
//
// The entries live in scope segments (hotkeys-diff.ts, hotkeys-app.ts) purely for size, and this
// file owns their order - the dispatcher's first-match rule makes that order part of the contract:
// the modal keys below come first because ⌘↵ must send while the Send modal is up even with a
// composer still open behind it, and ↵ must confirm a dialog raised from the diff.
const HOTKEYS_MODAL: Hotkey[] = [
	// Confirm dialog (⇧R / ⇧S / ⇧A): Enter accepts (Esc cancels via the escape cascade). First so
	// it wins over any plain-key binding while the dialog is up.
	{
		combo: '↵',
		desc: 'Confirm',
		group: 'App',
		test: enter,
		when: () => !!S.confirmMsg,
		run: confirmYes,
		hide: true,
	},
	// Send modal: ⌘↵ sends (typing:true - focus is in the note box). Plain Enter has no matching
	// typing hotkey, so it falls through to a textarea newline; Esc cancels via the escape cascade.
	{
		combo: '⌘↵',
		desc: 'Send to agent',
		group: 'App',
		test: cmd('Enter'),
		when: () => S.sendOpen,
		typing: true,
		run: () => S.sendConfirm?.(),
		hide: true,
	},
]

const HOTKEYS: Hotkey[] = [...HOTKEYS_MODAL, ...HOTKEYS_DIFF, ...HOTKEYS_APP]

function isTyping(e: KeyboardEvent): boolean {
	const { target } = e
	if (!(target instanceof HTMLElement)) return false
	return (
		target.tagName === 'INPUT' ||
		target.tagName === 'TEXTAREA' ||
		target.isContentEditable
	)
}

export function installKeys(): void {
	document.addEventListener('keydown', e => {
		const typing = isTyping(e)
		for (const h of HOTKEYS) {
			if (!h.test(e)) continue
			if (typing && !h.typing) continue
			if (h.when && !h.when()) continue
			// Any other action abandons pending goline digits - otherwise the idle timer would
			// yank the cursor away ~800ms after e.g. a j/⇧Y that already moved on.
			if (!h.goline) golineCancel()
			e.preventDefault()
			h.run(e)
			return
		}
	})
}

// Grouped view for the ? help overlay (built from the table so it stays in sync).
export function helpGroups(): {
	group: Group
	items: { combo: string; desc: string }[]
}[] {
	const order: Group[] = ['Navigate', 'Review', 'Comment', 'View', 'App']
	return order.map(group => ({
		group,
		items: HOTKEYS.filter(h => h.group === group && !h.hide).map(h => ({
			combo: h.combo,
			desc: h.desc,
		})),
	}))
}
