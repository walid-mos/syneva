import type { ChangeState, Decision, ReviewComment, ReviewState } from './types'

// ── One-pass file index for bulk derivations ─────────────────────────────────
// The tree, walkthrough, progress bar, nav seeks, and the completion gate all classify EVERY
// file per evaluation - and the per-path predicates they leaned on (fileReviewState /
// fileFinished) each rescan the GLOBAL changes/comments/decisions/files arrays. At 1,275 files × 3,542 change blocks that is millions of reads per
// pass, every read through Alpine's dependency-tracking proxy: a single file switch froze the
// main thread for ~20s on a real monorepo desk. This module groups everything by path in ONE
// pass, so a bulk caller does O(files + changes + comments + decisions) work per evaluation.
//
// Reactivity is preserved by construction: the builder reads the same reactive properties the
// per-path predicates read (path/status of every change, etc.), just once each - so an
// Alpine effect that builds the index tracks the same dependencies and re-runs on the same
// mutations. That is also why the index must be built PER EVALUATION and never cached across
// effects: a cache hit inside a different effect would register no dependencies at all.
//
// The lookups below MUST mirror the single-call predicates, which stay the source of truth for
// one-off call sites: fileFinished/fileObjections/fileReviewState (changes.ts). flow-index.test.ts
// pins the parity.

export type FlowIndex = {
	// s.changes / s.comments grouped by path (absent path → no entry; callers default to []).
	changesByPath: Map<string, ChangeState[]>
	commentsByPath: Map<string, ReviewComment[]>
	// Files that left the reviewer's default flow: pure renames (issue 01), whose row is a muted
	// "renamed · no changes" note. They fold into the collapsed "Renamed" group, stay out of the
	// nav order, and carry no progress weight.
	outOfFlow: Set<string>
	// Fully-approved files the hide-reviewed pref distills out of the tree/walkthrough into
	// the collapsed "Reviewed" group. Navigation, progress weight, and the completion gate
	// deliberately keep treating them normally. EMPTY whenever the pref is off, so every
	// call site can read the set unconditionally.
	distilled: Set<string>
	// Mirror fileFinished / fileReviewState.
	finished(path: string): boolean
	reviewState(path: string): 'pending' | 'approved' | 'changes-requested'
}

type IndexedState = Pick<
	ReviewState,
	| 'files'
	| 'changes'
	| 'comments'
	| 'decisions'
	| 'reviewedFiles'
	| 'reviewedFileHashes'
>

const EMPTY: IndexedState = {
	files: [],
	changes: [],
	comments: [],
	reviewedFiles: [],
}

type PathItem = { path: string }

function groupByPath<Entry extends PathItem>(
	entries: Entry[],
): Map<string, Entry[]> {
	const byPath = new Map<string, Entry[]>()
	for (const entry of entries) {
		const list = byPath.get(entry.path)
		if (list) list.push(entry)
		else byPath.set(entry.path, [entry])
	}
	return byPath
}

// fileObjections' comment half: open, by the user, not a question.
function openChangePathSet(comments: ReviewComment[]): Set<string> {
	const paths = new Set<string>()
	for (const c of comments) {
		if (
			c.status === 'open' &&
			c.role !== 'agent' &&
			c.intent !== 'question'
		)
			paths.add(c.path)
	}
	return paths
}

// fileObjections' decision half: any rejected hunk on the path.
function rejectedPathSet(decisions: Decision[]): Set<string> {
	const paths = new Set<string>()
	for (const d of decisions) if (d.status === 'rejected') paths.add(d.path)
	return paths
}

// Mirrors the single-call predicates over every path in s.files: a pure rename left the flow
// (renames.ts); every other file is reviewed normally.
function classifyFiles(files: ReviewState['files']): {
	contentHash: Map<string, string>
	outOfFlow: Set<string>
} {
	const contentHash = new Map<string, string>()
	const outOfFlow = new Set<string>()
	for (const f of files) {
		contentHash.set(f.path, f.contentHash)
		if (f.renamePure) outOfFlow.add(f.path)
	}
	return { contentHash, outOfFlow }
}

export function deriveFlowIndex(
	s: IndexedState | null | undefined,
	options: { distill?: boolean } = {},
): FlowIndex {
	const st = s ?? EMPTY
	const changesByPath = groupByPath(st.changes)
	const commentsByPath = groupByPath(st.comments)
	const openChangePaths = openChangePathSet(st.comments)
	const rejectedPaths = rejectedPathSet(st.decisions ?? [])
	const reviewed = new Set(st.reviewedFiles)
	const hashes = st.reviewedFileHashes ?? {}
	const { contentHash, outOfFlow } = classifyFiles(st.files)
	// Resolved below off reviewState (a pure rename can't be approved - it has no blocks).
	const distilled = new Set<string>()

	// fileFinished: signed off AND the recorded hash still matches the file's current content
	// key. A path not in files has no contentHash entry, so the equality fails - same as the
	// original's `!!file` guard.
	const finished = (path: string): boolean => {
		const h = hashes[path]
		return reviewed.has(path) && !!h && h === contentHash.get(path)
	}
	const reviewState = (
		path: string,
	): 'pending' | 'approved' | 'changes-requested' => {
		if (!finished(path)) return 'pending'
		return rejectedPaths.has(path) || openChangePaths.has(path)
			? 'changes-requested'
			: 'approved'
	}
	// The distilled set mirrors reviewState()'s approved branch, folded in the same single
	// pass. It's resolved per EVALUATION (never cached across effects) exactly like finished.
	if (options.distill)
		for (const file of st.files.filter(
			x => reviewState(x.path) === 'approved',
		))
			distilled.add(file.path)
	return {
		changesByPath,
		commentsByPath,
		outOfFlow,
		distilled,
		finished,
		reviewState,
	}
}
