import {
	currentComments,
	currentFileOrNull,
	isFileComment,
	isUnanchored,
} from '@entities/review/changes'

import { diffCtx } from './context'

import type { ThreadMeta } from '@entities/review/annotations'
import type { ReviewComment } from '@entities/review/model'

// ── Unanchored comment threads ───────────────────────────────────────────────
// An open thread whose anchor line no longer exists can't render as a diff annotation  -
// and an open change request blocks approval, so it must stay reachable. These threads
// are pulled out of the annotation flow; the DOM strip that surfaces them lives in
// widgets/comment-thread/strip.ts (built per render alongside the whole-file comment
// section - the two header strips). The anchor check itself (isUnanchored) lives with the
// other review derivations in entities/review/changes.ts.

// Open unanchored threads of the current file, grouped like annotations() groups them. Whole-file
// comments never unanchor - they ride the file header (file-comments.ts), not a rendered line.
export function unanchoredThreads(): ThreadMeta[] {
	const file = currentFileOrNull(
		diffCtx().S.state?.files,
		diffCtx().S.preview,
		diffCtx().S.fileIndex,
	)
	if (!file) return []
	const groups = new Map<string, ReviewComment[]>()
	for (const c of currentComments(
		diffCtx().S.state,
		currentFileOrNull(
			diffCtx().S.state?.files,
			diffCtx().S.preview,
			diffCtx().S.fileIndex,
		),
	)) {
		if (isFileComment(c)) continue
		const key = `${c.side}:${c.lineNumber}`
		const group = groups.get(key)
		if (group) group.push(c)
		else groups.set(key, [c])
	}
	const out: ThreadMeta[] = []
	for (const comments of groups.values()) {
		comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
		const open = comments.some(c => c.status === 'open')
		if (!open) continue // a resolved orphan is done - nothing to act on
		if (!comments.some(c => isUnanchored(c, file))) continue
		const [first] = comments
		out.push({
			type: 'thread',
			path: first.path,
			side: first.side,
			lineNumber: first.lineNumber,
			status: 'open',
			comments,
		})
	}
	return out
}
