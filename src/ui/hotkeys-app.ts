import { closeComposer } from './composer'
import { askConfirm } from './confirm'
import {
	cursorReset,
	cursorSelection,
	golineActive,
	golineCancel,
} from './cursor'
import { hasGuide } from './guide'
import {
	cmdShift,
	enter,
	inComposer,
	inOverview,
	key,
	navigable,
	shift,
} from './hotkey-matchers'
import { S } from './store'

import type { Hotkey } from './hotkey-matchers'

// The app-wide keyboard map: moving between files, opening an app surface (overview, sidebar,
// drawer, settings), and the Esc cascade that closes the topmost one. Split from the diff's own
// map (hotkeys-diff.ts) only for size; keys.ts concatenates the segments and owns the dispatch
// order.
function escape(): void {
	if (golineActive()) {
		golineCancel()
		return
	}
	if (S.confirmMsg) {
		S.confirmMsg = ''
		return
	}
	if (S.sendOpen) {
		S.sendOpen = false
		S.sendNote = ''
		return
	}
	if (S.settingsOpen) {
		S.settingsOpen = false
		return
	}
	if (S.composerOpen || S.editingCommentId) {
		cursorReset() // also drop the line highlight the composer was anchored to
		closeComposer() // rebuilds the diff so the inline composer's DOM goes away
		return
	}
	// A lone line selection (keyboard cursor, or a click that left the highlight without an open
	// surface): Esc clears it. Below the surfaces above so Esc dismisses a composer/modal first.
	if (cursorSelection()) {
		cursorReset()
		return
	}
	// Lowest priority: the narrow-width file drawer. Closes only once every transient surface
	// above it is gone, so Esc dismisses a composer/modal opened over the drawer first.
	if (S.treeDrawerOpen) S.treeDrawerOpen = false
}

export const HOTKEYS_APP: Hotkey[] = [
	{
		combo: '⇧→',
		desc: 'Next file (review order)',
		group: 'Navigate',
		test: shift('ArrowRight'),
		when: navigable,
		run: () => S.nextFile?.(),
	},
	{
		combo: '⇧←',
		desc: 'Previous file (review order)',
		group: 'Navigate',
		test: shift('ArrowLeft'),
		when: navigable,
		run: () => S.prevFile?.(),
	},
	{
		combo: '⌘⇧↓',
		desc: 'Next file (tree order)',
		group: 'Navigate',
		test: cmdShift('ArrowDown'),
		when: navigable,
		run: () => S.treeStep?.(1),
	},
	{
		combo: '⌘⇧↑',
		desc: 'Previous file (tree order)',
		group: 'Navigate',
		test: cmdShift('ArrowUp'),
		when: navigable,
		run: () => S.treeStep?.(-1),
	},
	{
		combo: 'o',
		desc: 'Overview',
		group: 'Navigate',
		test: key('o'),
		when: () => hasGuide() && navigable(),
		run: () => S.openOverview?.(),
	},
	{
		combo: '↵',
		desc: 'Start review',
		group: 'Navigate',
		test: enter,
		when: inOverview,
		run: () => S.startGuided?.(),
	},
	{
		combo: 'w',
		desc: 'Tree / Walkthrough sidebar',
		group: 'View',
		when: () => hasGuide() && navigable(),
		test: key('w'),
		run: () =>
			(S.sidebarTab = S.sidebarTab === 'tree' ? 'walkthrough' : 'tree'),
	},
	{
		combo: '⇧B',
		desc: 'Files drawer (narrow screens)',
		group: 'View',
		when: navigable,
		test: shift('B'),
		// Toggles the off-canvas file tree at narrow widths; inert on desktop (drawer is media-gated).
		run: () => (S.treeDrawerOpen = !S.treeDrawerOpen),
	},
	{
		combo: '⇧R',
		desc: 'Reset review',
		group: 'App',
		test: shift('R'),
		when: navigable,
		run: () =>
			askConfirm(
				'Reset the whole review? This clears every decision and comment.',
				() => void S.reset?.(),
			),
	},
	{
		combo: '⇧S',
		desc: 'Send to agent',
		group: 'App',
		test: shift('S'),
		when: navigable,
		run: () => S.confirmSend?.(),
	},
	{
		combo: '⇧,',
		desc: 'Settings',
		group: 'App',
		test: e =>
			(e.key === '<' || (e.key === ',' && e.shiftKey)) &&
			!e.metaKey &&
			!e.ctrlKey &&
			!e.altKey,
		when: () => !inComposer(),
		run: () => S.openSettings?.(),
	},
	{
		combo: 'Esc',
		desc: 'Close / cancel',
		group: 'App',
		test: e => e.key === 'Escape',
		typing: true,
		run: escape, // cancels pending goline digits first (see escape()), so no dispatcher pre-cancel
		goline: true,
	},
]
