import { hasCurrentFile } from './changes'
import {
	cursorComment,
	cursorMoveHunk,
	cursorMoveLine,
	cursorResolve,
	cursorVerdict,
	golineActive,
	golineCommit,
	golineDigit,
} from './cursor'
import { approveCurrentFile } from './decisions'
import {
	cmd,
	cmdShift,
	enter,
	inComposer,
	inDiff,
	isMd,
	key,
	shift,
} from './hotkey-matchers'
import { isOversizedPlaceholder, loadOversizedDiff } from './oversized'
import { S } from './store'

import type { Hotkey } from './hotkey-matchers'

// The diff's own keyboard map: the keys that act on the line, change, or file under the cursor,
// plus the comment and review verdicts they lead to. Split from the app-wide map (hotkeys-app.ts)
// only for size; keys.ts concatenates the segments and owns the dispatch order.
export const HOTKEYS_DIFF: Hotkey[] = [
	{
		combo: '⇧↓',
		desc: 'Next change',
		group: 'Navigate',
		test: shift('ArrowDown'),
		when: inDiff,
		run: () => cursorMoveHunk(1),
	},
	{
		combo: '⇧↑',
		desc: 'Previous change',
		group: 'Navigate',
		test: shift('ArrowUp'),
		when: inDiff,
		run: () => cursorMoveHunk(-1),
	},
	{
		combo: '↑',
		desc: 'Move up a line',
		group: 'Navigate',
		test: key('ArrowUp'),
		when: inDiff,
		run: () => cursorMoveLine(-1),
	},
	{
		combo: '↓',
		desc: 'Move down a line',
		group: 'Navigate',
		test: key('ArrowDown'),
		when: inDiff,
		run: () => cursorMoveLine(1),
	},
	{
		combo: 'j',
		desc: 'Next change',
		group: 'Navigate',
		test: key('j'),
		when: inDiff,
		run: () => cursorMoveHunk(1),
		hide: true,
	},
	{
		combo: 'k',
		desc: 'Previous change',
		group: 'Navigate',
		test: key('k'),
		when: inDiff,
		run: () => cursorMoveHunk(-1),
		hide: true,
	},
	{
		combo: '1-9',
		desc: 'Go to line (↵ jump, esc cancel)',
		group: 'Navigate',
		test: e =>
			/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey,
		when: inDiff,
		run: e => golineDigit(e.key),
		goline: true,
	},
	// Goline commit must outrank "comment on line" while digits are pending - same key, same scope.
	{
		combo: '↵',
		desc: 'Jump to typed line',
		group: 'Navigate',
		test: enter,
		when: () => inDiff() && golineActive(),
		run: () => golineCommit(),
		goline: true,
		hide: true,
	},
	// On an oversized-file placeholder card there's no line to comment on - ↵ loads the real diff
	// instead. More specific than the plain-↵ comment binding below, so it wins in that one scope.
	{
		combo: '↵',
		desc: 'Load diff anyway (large file)',
		group: 'Review',
		test: enter,
		when: () => inDiff() && isOversizedPlaceholder(),
		run: () => loadOversizedDiff(),
	},
	{
		combo: '↵',
		desc: 'Comment / reply on line',
		group: 'Comment',
		test: enter,
		when: inDiff,
		run: () => cursorComment(),
	},
	{
		combo: 'c',
		desc: 'Comment on line',
		group: 'Comment',
		test: key('c'),
		when: inDiff,
		run: () => cursorComment(),
		hide: true,
	}, // alias for ↵
	{
		combo: 'r',
		desc: 'Resolve / reopen thread',
		group: 'Comment',
		test: key('r'),
		when: inDiff,
		run: () => cursorResolve(),
	},
	{
		combo: '⌘↵',
		desc: 'Submit comment (Request change)',
		group: 'Comment',
		test: cmd('Enter'),
		when: inComposer,
		typing: true,
		run: () => S.saveComment?.(),
	},
	{
		combo: '⌘⇧↵',
		desc: 'Submit as question (Ask)',
		group: 'Comment',
		test: cmdShift('Enter'),
		when: () => inComposer() && !S.editingCommentId,
		typing: true,
		run: () => S.ask?.(),
	},
	{
		combo: '⇧Y',
		desc: 'Accept change (Keep)',
		group: 'Review',
		test: shift('Y'),
		when: inDiff,
		run: () => cursorVerdict('accepted'),
	},
	{
		combo: '⇧N',
		desc: 'Reject change (Undo)',
		group: 'Review',
		test: shift('N'),
		when: inDiff,
		run: () => cursorVerdict('rejected'),
	},
	{
		combo: 'v',
		desc: 'Split / Stacked',
		group: 'View',
		test: key('v'),
		when: inDiff,
		run: () => S.setStyle?.(S.diffStyle === 'split' ? 'unified' : 'split'),
	},
	{
		combo: 'm',
		desc: 'Rendered / source (markdown)',
		group: 'View',
		test: key('m'),
		when: isMd,
		run: () =>
			S.setFileView?.(S.fileView === 'rendered' ? 'source' : 'rendered'),
	},
	{
		combo: '⇧E',
		desc: 'Open in editor',
		group: 'View',
		test: shift('E'),
		when: inDiff,
		run: () => void S.openInEditor?.(),
	},
	{
		combo: '⇧A',
		desc: 'Approve / mark file reviewed',
		group: 'Review',
		test: shift('A'),
		// The diff's own surface AND a file to approve: before the first state lands, or on a
		// review a reload emptied, approving would reach currentFile()'s ready-only throw.
		when: () => inDiff() && hasCurrentFile(),
		run: () => void approveCurrentFile(),
	},
]
