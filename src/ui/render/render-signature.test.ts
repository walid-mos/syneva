import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderSignature } from './render-signature'

import type { ChangeState, ReviewComment } from '../types'

// renderSignature feeds the renderDiffInstance no-op guard: every input that would repaint the
// #diff rows must flip it, every irrelevant input must not. A missed repaint input freezes the
// pane (the production bug: decisions/comments land, nothing changes); an extra flip defeats
// the guard (perpetual full re-render). Pure over projected lists, so each case pins exactly
// one input - named as the repaint behavior it guards.
type View = { isPreviewing: boolean; isExpandedUnchanged: boolean }

const VIEW: View = { isPreviewing: false, isExpandedUnchanged: false }

const FILE: {
	path: string
	contentHash: string
	oldPath: string | null
	newPath: string | null
} = {
	path: 'src/a.ts',
	contentHash: 'hash-1',
	oldPath: null,
	newPath: null,
}

function change(over: {
	id?: string
	status?: ChangeState['status']
	skimCollapsed?: boolean
}): { id: string; status: ChangeState['status']; skimCollapsed: boolean } {
	return {
		id: 'c1',
		status: 'pending',
		skimCollapsed: false,
		...over,
	}
}

function comment(
	over: Partial<ReviewComment> & { id?: string },
): ReviewComment {
	return {
		id: 't1',
		path: 'src/a.ts',
		side: 'additions',
		lineNumber: 12,
		body: 'tighten this',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		status: 'open',
		...over,
	}
}

// Fresh-construction digest of the same data twice: determinism (the guard's skip is only
// correct when equal data digests equal).
function digest(over: {
	file?: Partial<typeof FILE>
	view?: Partial<View>
	changes?: {
		id: string
		status: ChangeState['status']
		skimCollapsed: boolean
	}[]
	comments?: ReviewComment[]
	composer?: {
		composerOpen: boolean
		editingCommentId: string | null
		selected: {
			side: 'additions' | 'deletions'
			lineNumber: number
			endLine?: number
		}
	}
}): string {
	return renderSignature(
		{ ...FILE, ...over.file },
		{ ...VIEW, ...over.view },
		over.changes ?? [],
		{
			comments: over.comments ?? [],
			composer: over.composer ?? {
				composerOpen: false,
				editingCommentId: null,
				selected: { side: 'additions', lineNumber: 1 },
			},
		},
	)
}

void test('opening, moving, editing and closing a composer repaint without changing comments', () => {
	const comments = [comment({})]
	const composer = {
		composerOpen: true,
		editingCommentId: null,
		selected: { side: 'additions' as const, lineNumber: 12 },
	}
	const closed = digest({ comments })
	const opened = digest({ comments, composer })
	assert.notEqual(opened, closed)
	assert.notEqual(
		digest({
			comments,
			composer: {
				...composer,
				selected: { side: 'deletions', lineNumber: 12 },
			},
		}),
		opened,
	)
	assert.notEqual(
		digest({
			comments,
			composer: {
				...composer,
				selected: { side: 'additions', lineNumber: 20 },
			},
		}),
		opened,
	)
	assert.notEqual(
		digest({ comments, composer: { ...composer, editingCommentId: 't1' } }),
		opened,
	)
	assert.deepEqual(
		digest({ comments, composer: { ...composer, composerOpen: false } }),
		closed,
	)
})

void test('equal data digests identically', () => {
	const first = digest({
		changes: [change({})],
		comments: [comment({})],
	})
	const second = digest({
		changes: [change({})],
		comments: [comment({})],
	})
	assert.ok(first === second, 'equal data must digest identically')
})

void test('a decision flip repaints', () => {
	const pending = digest({ changes: [change({})] })
	const rejected = digest({ changes: [change({ status: 'rejected' })] })
	assert.notEqual(pending, rejected)
})

void test('comment set membership repaints', () => {
	const empty = digest({})
	const one = digest({ comments: [comment({})] })
	const two = digest({
		comments: [comment({}), comment({ id: 't2', lineNumber: 20 })],
	})
	assert.notEqual(one, empty)
	assert.notEqual(two, one)
})

void test('a thread moving to another line repaints', () => {
	const at12 = digest({ comments: [comment({})] })
	const at30 = digest({ comments: [comment({ lineNumber: 30 })] })
	assert.notEqual(at12, at30)
})

void test('an in-place thread edit repaints (updatedAt)', () => {
	const before = digest({ comments: [comment({})] })
	const edited = digest({
		comments: [comment({ updatedAt: '2026-01-02T00:00:00.000Z' })],
	})
	assert.notEqual(before, edited)
})

void test("a comment's resolution state repaints", () => {
	const open = digest({ comments: [comment({})] })
	const resolved = digest({ comments: [comment({ status: 'resolved' })] })
	assert.notEqual(open, resolved)
})

void test('a skim block toggle repaints', () => {
	const expanded = digest({ changes: [change({ skimCollapsed: false })] })
	const collapsed = digest({ changes: [change({ skimCollapsed: true })] })
	assert.notEqual(expanded, collapsed)
})

void test('content change repaints (contentHash)', () => {
	const hash1 = digest({})
	const hash2 = digest({ file: { contentHash: 'hash-2' } })
	assert.notEqual(hash1, hash2)
})

void test('view flags repaint', () => {
	const baseline = digest({})
	assert.notEqual(digest({ view: { isPreviewing: true } }), baseline)
	assert.notEqual(digest({ view: { isExpandedUnchanged: true } }), baseline)
})

void test('rename metadata repaints', () => {
	const samePath = digest({})
	const moved = digest({ file: { newPath: 'src/b.ts' } })
	assert.notEqual(samePath, moved)
})
