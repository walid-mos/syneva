import { commentSide, parseLineNumber } from '../../../../domain/comments.js'

import type { CommentInput } from '../../../../domain/comments.js'

// Transport shape validation for the shared ask/comment body ({ path, body, lineNumber, side }):
// both /api/comment and /api/ask post it (see `syneva spec`). A body needs a file and text;
// everything else has a documented default (additions, line 1, an agent-authored reply).
// lineNumber 0 is the whole-file anchor (see backend/domain/comments.ts) - a file comment has no
// diff side, so the side it may carry is normalized away. Returns null when the request lacks
// what it cannot default - the route answers 422 (INVALID_COMMENT / INVALID_QUESTION).
export function parseCommentRequest(payload: unknown): CommentInput | null {
	if (typeof payload !== 'object' || payload === null) return null
	const filePath =
		'path' in payload && typeof payload.path === 'string'
			? payload.path
			: ''
	const text =
		'body' in payload && typeof payload.body === 'string'
			? payload.body.trim()
			: ''
	if (!filePath || !text) return null
	const line = 'lineNumber' in payload ? payload.lineNumber : undefined
	const lineNumber = parseLineNumber(line)
	if (lineNumber === null) return null
	return {
		path: filePath,
		lineNumber,
		side: commentSide(
			'side' in payload && payload.side === 'deletions'
				? 'deletions'
				: 'additions',
			lineNumber,
		),
		body: text,
		role: 'role' in payload && payload.role === 'user' ? 'user' : 'agent',
	}
}
