import type { Side } from '@shared/diff-renderer/types'
import type { ReviewComment } from './model'

// ── Annotation metadata (pure shapes shared by features and the diff renderer) ──
// The imperative diff island tags every rendered line with one of these metadata
// variants; the composer targeting, thread strips and change annotations all key
// off them. Pure data only - the @pierre-typed annotation payload wrapper
// (DiffLineAnnotation<AnnotationMeta>) stays in widgets/diff-view/types.ts, which
// is the only place that instantiates the library generic.
export type ThreadMeta = {
	type: 'thread'
	path: string
	side: Side
	lineNumber: number
	status: 'open' | 'resolved'
	comments: ReviewComment[]
	changeId?: string
	// Whole-file thread (anchored to the file header, not a diff row): the reply composer and
	// open/close routes through the file composer instead of the line one.
	fileLevel?: boolean
}
export type ChangeMeta = {
	type: 'change'
	id: string
	side: Side
	lineNumber: number
	title: string
	path: string
}
// An inline composer slot injected on the fly for a new line comment (reply/edit render
// inside the thread, not as their own annotation). lineNumber is the display line the
// composer anchors under - it re-derives from S.selected on every render, so it tracks
// the selection across decision replays like any other annotation.
export type ComposerMeta = {
	type: 'composer'
	side: Side
	lineNumber: number
	path: string
}
export type AnnotationMeta = ThreadMeta | ChangeMeta | ComposerMeta
