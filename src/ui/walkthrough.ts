import type { BrowserReviewFile, GuideFile } from '../types'
import type { FileReviewState } from './types'

// Pure data for the Walkthrough sidebar tab - no store import (these are parameterized like
// linemap.ts so they stay testable under node:test).

export type LineStat = { added: number; removed: number }
type FileLike = Pick<
	BrowserReviewFile,
	'path' | 'added' | 'removed' | 'oldPath' | 'newPath' | 'renamePure'
>

// Counts are stamped by the server, including hunkless full-file additions. The browser never
// needs backend hunks to draw the sidebar; @pierre's rendered hunks stay separate.
export function lineStats(files: FileLike[]): Map<string, LineStat> {
	return new Map(
		files.map(file => [
			file.path,
			{ added: file.added, removed: file.removed },
		]),
	)
}

export type WalkFile = {
	path: string
	// dir + name === path; the templates dim the dir and emphasize the basename.
	dir: string
	name: string
	fileIndex: number
	// Pure rename (issue 01): the old path, "" when the file isn't one - the row shows a
	// "← old path" arrow.
	movedFrom: string
	added: number
	removed: number
	state: FileReviewState
}

export type WalkGroup = {
	category: string
	other: boolean // the trailing group of diff files the guide didn't list
	renamed: boolean // the trailing collapsed group of pure renames (issue 01)
	// The hide-reviewed lens' trailing collapsed group of fully-approved files. Exclusive
	// with renamed by construction (a pure rename has no blocks, so it can never be approved).
	reviewed?: boolean
	files: WalkFile[]
	added: number
	removed: number
	done: number // files no longer pending
	total: number
}

type GroupFlags = {
	isOther: boolean
	isRenamed?: boolean
	isReviewed?: boolean
}

function blankGroup(category: string, flags: GroupFlags): WalkGroup {
	return {
		category,
		other: flags.isOther,
		renamed: flags.isRenamed ?? false,
		reviewed: flags.isReviewed ?? false,
		files: [],
		added: 0,
		removed: 0,
		done: 0,
		total: 0,
	}
}

// Pure accumulator: groups are replaced, never mutated in place, so call sites can hold them in
// `const`/`let` bindings without reassigning a parameter's properties.
function withFile(group: WalkGroup, f: WalkFile): WalkGroup {
	return {
		...group,
		files: [...group.files, f],
		added: group.added + f.added,
		removed: group.removed + f.removed,
		total: group.total + 1,
		done: group.done + (f.state === 'pending' ? 0 : 1),
	}
}

function categoryKey(index: number, group: WalkGroup): string {
	if (group.renamed) return `cat:${index}:·renamed`
	if (group.reviewed) return `cat:${index}:·reviewed`
	if (group.other) return `cat:${index}:·other`
	return `cat:${index}:${group.category}`
}

// Build the per-file mapper once per walkthroughGroups call (it closes over the shared stats/index).
function fileBuilder(
	files: FileLike[],
	stats: Map<string, LineStat>,
	stateOf: (path: string) => FileReviewState,
): (path: string, fileIndex: number) => WalkFile {
	return (path, fileIndex): WalkFile => {
		const name = path.split('/').pop() ?? path
		const stat = stats.get(path) ?? { added: 0, removed: 0 }
		const file = files[fileIndex]
		const moved =
			file.oldPath && file.newPath && file.oldPath !== file.newPath
				? file.oldPath
				: ''
		return {
			path,
			dir: path.slice(0, path.length - name.length),
			name,
			fileIndex,
			movedFrom: moved,
			added: stat.added,
			removed: stat.removed,
			state: stateOf(path),
		}
	}
}

// Run-length grouping: categories and files in guide order, with a new section started each
// time the category changes from the previous *shown* file - so a category the agent lists
// non-contiguously yields separate sections instead of folding back up, and these surfaces
// mirror guideOrder() exactly. Guide entries absent from the diff are skipped (same rule as
// guideOrder); diff files absent from the guide land in a trailing "Other" group - so these
// surfaces always cover everything the progress strip counts and the two can never disagree.
// The two trailing collapsed fold groups plus the router that sends files into them:
// pure renames first, then the hide-reviewed lens' approved files; the route returns the file
// back when it stays shown. The buckets mutate in place during the walk (locals, not the
// immutable withFile path).
function foldBuckets(
	isRenamed: (path: string) => boolean,
	isDistilled: (path: string) => boolean,
): {
	renamed: WalkGroup
	reviewed: WalkGroup
	route: (path: string, file: WalkFile) => WalkFile | null
} {
	const renamed = blankGroup('Renamed', { isOther: false, isRenamed: true })
	const reviewed = blankGroup('Reviewed', {
		isOther: false,
		isReviewed: true,
	})
	const route = (path: string, file: WalkFile): WalkFile | null => {
		let bucket: WalkGroup | null = null
		if (isRenamed(path)) bucket = renamed
		else if (isDistilled(path)) bucket = reviewed
		if (!bucket) return file
		bucket.files.push(file)
		bucket.added += file.added
		bucket.removed += file.removed
		bucket.total++
		bucket.done += file.state === 'pending' ? 0 : 1
		return null
	}
	return { renamed, reviewed, route }
}

export function walkthroughGroups(
	guideFiles: GuideFile[],
	files: FileLike[],
	stateOf: (path: string) => FileReviewState,
	folds: {
		renamed: (path: string) => boolean
		distilled: (path: string) => boolean
	} = {
		renamed: (): boolean => false,
		distilled: (): boolean => false,
	},
): WalkGroup[] {
	const stats = lineStats(files)
	const index = new Map(files.map((f, i) => [f.path, i] as const))
	const mkFile = fileBuilder(files, stats, stateOf)
	const groups: WalkGroup[] = []
	const listed = new Set<string>()
	// Pure renames leave their normal group (guide category or Other) for the trailing collapsed
	// "Renamed" group (issue 01); the hide-reviewed lens folds fully-approved files into a
	// "Reviewed" group the same way.
	const buckets = foldBuckets(folds.renamed, folds.distilled)
	const { route } = buckets
	// Track only the current group: a skipped file (not in the diff) leaves no visible gap, so
	// it must not split a run - hence the category compare happens against the last *shown* file.
	let current: WalkGroup | null = null
	for (const guide of guideFiles) {
		listed.add(guide.path)
		const i = index.get(guide.path)
		if (typeof i !== 'number') continue
		const file = mkFile(guide.path, i)
		const shown = route(guide.path, file)
		if (!shown) continue
		// A folded file must not carry the run forward - compare/open the category off shown,
		// in-flow files only, so a folded file between two same-category files can't split them.
		if (!current || current.category !== guide.category) {
			current = blankGroup(guide.category, { isOther: false })
			groups.push(current)
		}
		current = withFile(current, shown)
		groups[groups.length - 1] = current
	}
	let otherGroup = blankGroup('Other', { isOther: true })
	files.forEach((file, i): void => {
		if (listed.has(file.path)) return
		const shown = route(file.path, mkFile(file.path, i))
		if (!shown) return
		otherGroup = withFile(otherGroup, shown)
	})
	if (otherGroup.total) groups.push(otherGroup)
	if (buckets.renamed.total) groups.push(buckets.renamed)
	if (buckets.reviewed.total) groups.push(buckets.reviewed)
	return groups
}

// Flat row list the sidebar template renders with x-for (the treeRows pattern): a header
// row per category, then its file rows. activePath marks the file being viewed (null on
// the Overview page - nothing is active there). `expanded` carries the per-session expand
// state of the two collapsible trailing groups.
export type ExpandedGroups = { renamed?: boolean; reviewed?: boolean }
export type WalkRow =
	| {
			kind: 'cat'
			key: string
			category: string
			other: boolean
			// The trailing collapsed "Renamed"/"Reviewed" group's header: a toggle, not a jump
			// target; `open` drives its caret, and its file rows are emitted only while open.
			renamed: boolean
			reviewed: boolean
			open: boolean
			total: number
			done: number
			added: number
			removed: number
			complete: boolean
			jumpIndex: number // diff index a header click selects (first pending in the group, else its first)
	  }
	| (WalkFile & { kind: 'file'; key: string; cls: string; style: string })

// Whether a group's rows hide behind its header: only the two trailing fold groups -
// Renamed (issue 01) and the hide-reviewed lens' Reviewed - collapse; every other group
// is always open.
function isCollapsed(group: WalkGroup, expanded: ExpandedGroups): boolean {
	if (group.renamed) return !expanded.renamed
	if (group.reviewed) return !expanded.reviewed
	return false
}

export function walkRows(
	groups: WalkGroup[],
	activePath: string | null,
	expanded: ExpandedGroups = {},
): WalkRow[] {
	const rows: WalkRow[] = []
	groups.forEach((group, gi): void => {
		// First not-yet-finished file in THIS group, else its first - the rule the old
		// firstFileOfCategory used, but scoped to the clicked occurrence, not the category name.
		// Groups always carry ≥1 file (guide groups get one per add; Other is only pushed if it has any).
		const target =
			group.files.find(f => f.state === 'pending') ?? group.files[0]
		const collapsed = isCollapsed(group, expanded)
		rows.push({
			kind: 'cat',
			// The group index keeps the key unique when a category label repeats across runs;
			// "·other" still distinguishes the synthetic trailer from a guide category named "Other".
			key: categoryKey(gi, group),
			category: group.category,
			other: group.other,
			renamed: group.renamed,
			reviewed: group.reviewed ?? false,
			open: !collapsed,
			total: group.total,
			done: group.done,
			added: group.added,
			removed: group.removed,
			complete: group.done === group.total,
			jumpIndex: target.fileIndex,
		})
		// A collapsed Renamed/Reviewed group hides its file rows until expanded; every other
		// group is always open.
		if (collapsed) return
		for (const f of group.files)
			rows.push({
				...f,
				kind: 'file',
				key: `file:${f.path}`,
				cls: f.path === activePath ? 'active' : '',
				style: '--depth:1',
			})
	})
	return rows
}
