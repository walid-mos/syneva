import {
	cmdShift,
	enter,
	inComposer,
	inNotes,
	inOverview,
	key,
	navigable,
	shift,
} from '@app/hotkey-matchers'
import { hasGuide } from '@entities/review/guide/guide'
import {
	closeComposer,
	closeFileComposer,
} from '@features/manage-comment/composer'
import { askConfirm } from '@widgets/dialogs/confirm'
import { cursorReset, cursorSelection } from '@widgets/diff-view/cursor'
import { golineActive, golineCancel } from '@widgets/diff-view/cursor-goline'

import { S } from './store'

import type { Hotkey } from '@app/hotkey-matchers'
import type { GuideInputs } from '@entities/review/guide/guide'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: S.state,
	fileIndex: S.fileIndex,
	hideReviewed: S.settings.hideReviewed,
	progressBy: S.settings.progressBy,
	foldExpanded: S.foldExpanded,
})

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
	// The notes panel's filter: Esc clears the query first, so closing the panel (which
	// would discard the search with it) stays a deliberate second press.
	if (S.notesOpen && S.notesQuery) {
		S.setNotesQuery?.('')
		return
	}
	// The review-notes panel: the topmost app overlay under the modals/composer - it can be
	// open while a composer sits behind it, so the composer's Esc stays one press deeper.
	if (S.notesOpen) {
		S.notesOpen = false
		return
	}
	// The whole-file composer closes without touching the line selection (it has none).
	if (S.fileComposerOpen) {
		closeFileComposer()
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

// The notes panel's own keys. Ranked above the diff's segment (keys.ts owns the order):
// with the panel up, its cursor owns the arrows and Enter - the diff behind stays
// mouse-reachable, and Esc yields the keys back the same way every open surface does.
export const HOTKEYS_NOTES: Hotkey[] = [
	{
		combo: '↑',
		desc: 'Previous note (panel)',
		group: 'Navigate',
		test: key('ArrowUp'),
		when: inNotes,
		run: () => S.notesCursorMove?.(-1),
	},
	{
		combo: '↓',
		desc: 'Next note (panel)',
		group: 'Navigate',
		test: key('ArrowDown'),
		when: inNotes,
		run: () => S.notesCursorMove?.(1),
	},
	{
		combo: '↵',
		desc: 'Jump to note (panel)',
		group: 'Navigate',
		test: enter,
		when: inNotes,
		run: () => S.notesJumpCursor?.(),
	},
	{
		combo: '/',
		desc: 'Filter notes (panel)',
		group: 'View',
		test: key('/'),
		when: inNotes,
		run: () => S.notesFocusSearch?.(),
	},
]

export const HOTKEYS_APP: Hotkey[] = [
	{
		combo: '⇧→',
		desc: 'Next file (active view order)',
		group: 'Navigate',
		test: shift('ArrowRight'),
		when: navigable,
		run: () => S.nextFile?.(),
	},
	{
		combo: '⇧←',
		desc: 'Previous file (active view order)',
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
		when: () => hasGuide(GI()) && navigable(),
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
		combo: '⇧H',
		desc: 'Hide approved changes (multi-round)',
		group: 'View',
		when: navigable,
		test: shift('H'),
		run: () => S.toggleHideReviewed?.(),
	},
	{
		combo: 'w',
		desc: 'Tree / Walkthrough sidebar',
		group: 'View',
		when: () => hasGuide(GI()) && navigable(),
		test: key('w'),
		run: () =>
			(S.sidebarTab = S.sidebarTab === 'tree' ? 'walkthrough' : 'tree'),
	},
	{
		combo: 'n',
		desc: 'Review notes (comments & questions)',
		group: 'View',
		// Reachable from the Overview and file mode too (the notes span the whole review);
		// only a live composer keeps it, since 'n' would be text there.
		when: () => !inComposer(),
		test: key('n'),
		run: () => S.toggleNotes?.(),
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
		combo: '⇧Q',
		desc: 'Close Syneva (stops the desk)',
		group: 'App',
		test: shift('Q'),
		when: navigable,
		run: () => S.confirmClose?.(),
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
