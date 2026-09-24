import { flowIndex } from '../changes'

import { movedFrom, isRenamedGroupExpanded } from './renames'
import { isReviewedGroupExpanded, pushReviewedGroup } from './reviewed'
import {
	CARET_CLOSED,
	CARET_OPEN,
	emptyNode,
	fileSignals,
	foldTestFiles,
	insertFile,
	stateBadge,
} from './tree-structure'

import type { FlowIndex } from '../change/flow-index'
import type { ReviewState } from '../model'
import type { FileRow, TreeFile, TreeNode, TreeRow } from './tree-rows'

// Everything one treeRows() evaluation reads, supplied explicitly by the caller (the app
// facade supplies it from the reactive store). Project listing + review + expansion state.
export type TreeInputs = {
	state: ReviewState
	projectFiles: string[]
	showUnchanged: boolean
	hideReviewed: boolean
	expandedDirs: Set<string>
	collapsedDirs: Set<string>
	foldExpanded: Set<string>
}

type ReviewFile = ReviewState['files'][number]

// Everything one treeRows() evaluation needs. The row builders take it explicitly instead of
// closing over the module, so each stays a function of its inputs. The signal helpers in
// tree-structure.ts read it (type-only import).
export type TreeBuild = {
	ix: FlowIndex
	/** the rows for this evaluation, in document order */
	rows: TreeRow[]
	/** the review's files - what a row's recorded index points back into */
	files: ReviewFile[]
	/** changed path -> the file's index in the review */
	changedIndex: Map<string, number>
	/** session expand/collapse state (see tree open defaults in walk) */
	expandedDirs: Set<string>
	collapsedDirs: Set<string>
	/** staged paths - a staged changed test reads as signed off, so it folds away */
	stagedFiles: string[]
	/** session fold state for the trailing Renamed group */
	foldExpanded: Set<string>
}

// Every directory path that holds one of `paths` (the file's own name excluded). The tree's
// expand/collapse controls and the touched-folder default both derive from this.
function dirPaths(paths: Iterable<string>): string[] {
	const dirs = new Set<string>()
	for (const path of paths) {
		const parts = path.split('/').filter(Boolean)
		let full = ''
		for (let i = 0; i < parts.length - 1; i++) {
			full = full ? `${full}/${parts[i]}` : parts[i]
			dirs.add(full)
		}
	}
	return [...dirs]
}

// Every directory path in the tree (independent of current open/closed state) - used by
// the collapse-all / expand-all control.
export function allDirPaths(inputs: TreeInputs): string[] {
	const changedPaths = inputs.state.files.map(f => f.path)
	if (!inputs.showUnchanged || !inputs.projectFiles.length)
		return dirPaths(changedPaths)
	return dirPaths([...new Set([...inputs.projectFiles, ...changedPaths])])
}

// Folders containing a "touched" file - one in the review (changed/staged) or carrying a
// comment. These are what "expand all" opens (purely-unchanged folders stay closed).
export function touchedDirPaths(state: ReviewState): string[] {
	return dirPaths([
		...state.files.map(f => f.path),
		...state.comments.map(c => c.path),
	])
}

// A changed file's type - drives the file-icon color. Reads the lean builder's `changeKind` stamp
// (issue 04) instead of the embedded contents; a rename shows as "modified" (its icon), like before.
// Row-signal derivation lives beside the structure helpers in tree-structure.ts.

// Indentation is computed (--depth feeds calc() in .node), not a class set - fixed
// indent-N classes capped at 3 levels and flattened anything deeper.
function indentStyle(depth: number): string {
	return depth ? `--depth:${depth}` : ''
}

function fileRow(
	build: TreeBuild,
	file: TreeFile,
	depth: number,
	isTest: boolean,
): void {
	const signals = fileSignals(build, file, isTest)
	// NOTE: the "active" highlight is deliberately NOT part of the row model. Deriving it here
	// read S.fileIndex/S.preview/S.overviewOpen, which made EVERY file switch a dependency-
	// triggered rebuild of the whole x-for (1,600+ rows re-bound to move one highlight - the
	// dominant per-switch cost on big desks). applyActiveRow() patches the class imperatively.
	build.rows.push({
		key: (isTest ? 'test:' : 'file:') + file.path,
		kind: isTest ? 'test' : 'file',
		depth,
		name: file.name,
		cls: [signals.isChangedish ? 'changed' : '', isTest ? 'test' : '']
			.filter(Boolean)
			.join(' '),
		style: indentStyle(depth),
		path: file.path,
		fileIndex: file.index,
		testToggle: signals.showsTestToggle,
		testKey: `tests:${file.path}`,
		testCaret: signals.areTestsOpen ? CARET_OPEN : CARET_CLOSED,
		changeType: signals.changeType,
		state: stateBadge(signals),
	})
	if (!signals.areTestsOpen) return
	// A changed test sorts above its unchanged siblings, then by name.
	file.tests.sort(
		(a, b) =>
			Number(b.changed) - Number(a.changed) ||
			a.name.localeCompare(b.name),
	)
	for (const test of file.tests) fileRow(build, test, depth + 1, true)
}

function walk(build: TreeBuild, node: TreeNode, depth: number): void {
	const dirs = [...node.dirs.values()]
	dirs.sort((a, b) => a.name.localeCompare(b.name))
	for (const dir of dirs) {
		// Changed folders default open (collapsible via collapsedDirs); unchanged default
		// closed (expandable via expandedDirs). Either way the chevron toggles.
		const isOpen = dir.changed
			? !build.collapsedDirs.has(dir.full)
			: build.expandedDirs.has(dir.full)
		build.rows.push({
			key: `dir:${dir.full}`,
			kind: 'dir',
			depth,
			name: dir.name,
			cls: dir.changed ? 'changed' : '',
			style: indentStyle(depth),
			full: dir.full,
			dirCaret: isOpen ? CARET_OPEN : CARET_CLOSED,
			open: isOpen,
			changed: dir.changed,
		})
		if (isOpen) walk(build, dir, depth + 1)
	}
	node.files.sort((a, b) => a.name.localeCompare(b.name))
	for (const file of node.files) fileRow(build, file, depth, false)
}

// A flat, muted row for a pure rename inside the collapsed group: no state badge and no
// "changed" cyan (it's out of the flow), just the "← old path" arrow. Clicking opens it like any
// file (which shows the muted "renamed · no changes" note in place of a diff).
function renamedFileRow(build: TreeBuild, path: string): FileRow {
	const movedFromPath = movedFrom(build.files, path)
	return {
		key: `file:${path}`,
		kind: 'file',
		depth: 1,
		name: path.split('/').pop() ?? path,
		cls: '', // "active" is patched imperatively - see applyActiveRow
		style: indentStyle(1),
		path,
		fileIndex: build.changedIndex.get(path),
		testToggle: false,
		testKey: '',
		testCaret: CARET_CLOSED,
		changeType: null,
		state: null,
		// A pure rename shows a "← old" arrow - movedFrom() returns '' when the path isn't a
		// rename, which the template's truthy check reads as absent.
		movedFrom: movedFromPath,
	}
}

// The collapsed "Renamed · N files" group at the very bottom - the test-fold precedent, but a
// flat group (no nesting). Expand state is per-session (isRenamedGroupExpanded); reviewed.ts
// builds a matching "Reviewed" group of approved files.
function appendRenamedGroup(build: TreeBuild, renamedPaths: string[]): void {
	if (!renamedPaths.length) return
	const isOpen = isRenamedGroupExpanded(build.foldExpanded)
	build.rows.push({
		kind: 'foldgrp',
		key: 'group:renamed',
		count: renamedPaths.length,
		open: isOpen,
		caret: isOpen ? CARET_OPEN : CARET_CLOSED,
		group: 'renamed',
	})
	if (!isOpen) return
	const ordered = [...renamedPaths]
	ordered.sort((a, b) => a.localeCompare(b))
	for (const path of ordered) build.rows.push(renamedFileRow(build, path))
}

// Pure data: the flat, ordered list of tree rows the template renders with x-for.
// (Replaces the old buildFileTree HTML-string builder + sync() DOM wiring.)
export function treeRows(inputs: TreeInputs): TreeRow[] {
	const { state } = inputs // the caller gates on a loaded review - see project-tree bindings
	// One O(changes+comments+files) pass for everything each row needs - per-row predicate calls
	// rescanned the global arrays and froze big desks (see flow-index.ts). Built fresh per
	// evaluation so the reactive store's field-level version tracking stays intact.
	const ix = flowIndex(state, { distill: inputs.hideReviewed })
	const changedPaths = state.files.map(f => f.path)
	const changedIndex = new Map(state.files.map((f, i) => [f.path, i]))
	// Files out of the main flow (pure renames - issue 01) leave the main listing and gather in the
	// collapsed group at the bottom - so they don't mark their folders as changed and don't clutter
	// the tree.
	const renamedPaths = changedPaths.filter(path => ix.outOfFlow.has(path))
	const renamedSet = new Set(renamedPaths)
	// The hide-reviewed lens folds fully-approved files the same way (a separate "Reviewed"
	// group) - a file already approved AND renamed stays in the renamed group (a pure rename has
	// no blocks, so it can never be approved anyway).
	const reviewed = inputs.hideReviewed
		? changedPaths.filter(
				path => !renamedSet.has(path) && ix.distilled.has(path),
			)
		: []
	const reviewedSet = new Set(reviewed)
	// A reviewed file must always appear, even if it isn't in the project listing (a new/
	// untracked file, or a stale listing): union the listing with the changed files when
	// showing unchanged; otherwise just the changed files. Folded files are held back.
	const listed =
		inputs.showUnchanged && inputs.projectFiles.length
			? [...new Set([...inputs.projectFiles, ...changedPaths])]
			: changedPaths
	const build: TreeBuild = {
		ix,
		rows: [],
		files: state.files,
		changedIndex,
		expandedDirs: inputs.expandedDirs,
		collapsedDirs: inputs.collapsedDirs,
		stagedFiles: state.stagedFiles,
		foldExpanded: inputs.foldExpanded,
	}
	const root = emptyNode('', '')
	for (const path of listed) {
		if (renamedSet.has(path) || reviewedSet.has(path)) continue
		insertFile(root, path, changedIndex.get(path))
	}
	root.files = foldTestFiles(root, state.stagedFiles)
	walk(build, root, 0)
	appendRenamedGroup(build, renamedPaths)
	pushReviewedGroup(
		build.rows,
		reviewed,
		isReviewedGroupExpanded(inputs.foldExpanded),
		path => changedIndex.get(path),
	)
	return build.rows
}
