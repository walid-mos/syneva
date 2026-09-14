import { flowIndex } from './changes'
import { movedFrom, isSkimGroupExpanded } from './skim'
import { S } from './store'
import { emptyNode, foldTestFiles, insertFile } from './tree-structure'

import type { FlowIndex } from './flow-index'
import type { FileRow, ReviewState, TreeFile, TreeNode, TreeRow } from './types'

type ReviewFile = ReviewState['files'][number]

// The caret glyphs the template renders for an open/closed branch.
const CARET_OPEN = '▾'
const CARET_CLOSED = '▸'

// Everything one treeRows() evaluation needs. The row builders take it explicitly instead of
// closing over the module, so each stays a function of its inputs.
type TreeBuild = {
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
export function allDirPaths(): string[] {
	if (!S.state) return []
	const changedPaths = S.state.files.map(f => f.path)
	if (!S.settings.showUnchanged || !S.projectFiles.length)
		return dirPaths(changedPaths)
	return dirPaths([...new Set([...S.projectFiles, ...changedPaths])])
}

// Folders containing a "touched" file - one in the review (changed/staged) or carrying a
// comment. These are what "expand all" opens (purely-unchanged folders stay closed).
export function touchedDirPaths(): string[] {
	if (!S.state) return []
	return dirPaths([
		...S.state.files.map(f => f.path),
		...S.state.comments.map(c => c.path),
	])
}

// A changed file's type - drives the file-icon color. Reads the lean builder's `changeKind` stamp
// (issue 04) instead of the embedded contents; a rename shows as "modified" (its icon), like before.
function changeType(
	file: TreeFile,
	files: ReviewFile[],
): FileRow['changeType'] {
	const { index } = file
	if (typeof index !== 'number') return null
	const changed = files.at(index)
	if (!changed) return null
	if (changed.changeKind === 'added') return 'new'
	if (changed.changeKind === 'deleted') return 'deleted'
	return 'modified'
}

// The review already decided every change block of this file (nothing left pending).
function isDecided(ix: FlowIndex, path: string): boolean {
	const decisions = ix.changesByPath.get(path) ?? []
	return decisions.length > 0 && decisions.every(c => c.status !== 'pending')
}

// Nothing about this file still asks for attention: not finished, not decided, not commented.
function isQuiet(ix: FlowIndex, path: string): boolean {
	const comments = ix.commentsByPath.get(path)
	return !ix.finished(path) && !isDecided(ix, path) && !comments?.length
}

// A changed test stays revealed for its whole lifecycle (like any changed file) so it doesn't
// vanish from the tree the moment it's approved - only *unchanged* sibling tests stay folded.
function hasChangedTest(file: TreeFile): boolean {
	return file.tests.some(test => test.changed)
}

// The parent filename reads as "needs attention" (cyan) only while a changed test is still
// pending; once every changed test is signed off, the parent goes neutral (dealt with).
function hasPendingChangedTest(ix: FlowIndex, file: TreeFile): boolean {
	return file.tests.some(
		test => test.changed && ix.reviewState(test.path) === 'pending',
	)
}

// Everything the row model derives about one file - now a change to the badge rules (who is
// "changed", whose caret shows) is readable without walking the row object.
type FileSignals = {
	state: FileRow['state']
	changeType: FileRow['changeType']
	/** the name still reads as "changed" (cyan): a pending changed file, or a pending child test */
	isChangedish: boolean
	/** the test caret is shown instead of the state badge */
	showsTestToggle: boolean
	/** the test list is expanded under this file */
	areTestsOpen: boolean
}

function fileSignals(
	build: TreeBuild,
	file: TreeFile,
	isTest: boolean,
): FileSignals {
	const { ix } = build
	const state = file.changed ? ix.reviewState(file.path) : null
	// "Changed" (cyan) filename = still needs attention: a pending changed file, or a child test
	// that's still pending. Approved / changes-requested files read as neutral (dealt with).
	const isChangedish =
		(file.changed && state === 'pending') || hasPendingChangedTest(ix, file)
	// Only a real file owns test rows; a test never does.
	const ownsTests = !isTest && file.tests.length > 0
	return {
		state,
		changeType: isChangedish ? changeType(file, build.files) : null,
		isChangedish,
		// A file with tests shows the test-toggle caret instead of a badge only when it's otherwise
		// "quiet" (not finished / decided / commented).
		showsTestToggle: ownsTests && isQuiet(ix, file.path),
		areTestsOpen:
			ownsTests &&
			(build.expandedDirs.has(`tests:${file.path}`) ||
				hasChangedTest(file)),
	}
}

// Indentation is computed (--depth feeds calc() in .node), not a class set - fixed
// indent-N classes capped at 3 levels and flattened anything deeper.
function indentStyle(depth: number): string {
	return depth ? `--depth:${depth}` : ''
}

// A file showing its test caret reads through the caret instead of the review-state badge.
function stateBadge(signals: FileSignals): FileRow['state'] {
	if (signals.showsTestToggle) return null
	return signals.state
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
		skim: file.changed && build.ix.fullySkimmed.has(file.path),
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

// A flat, muted row for a fully-skimmed file inside the collapsed group: no state badge and no
// "changed" cyan (it's out of the flow), just the skim indicator. Clicking opens it like any
// file - its file/block skim strips render as issue 06 built.
function skimFileRow(build: TreeBuild, path: string): FileRow {
	const movedFromPath = movedFrom(path)
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
		// A pure rename shows a "← old" arrow instead of the skim indicator (it's moved, not skimmed).
		// movedFrom() returns '' when the path isn't a rename, which the template's truthy check reads
		// as absent (the same convention the walkthrough rows use).
		skim: !movedFromPath,
		movedFrom: movedFromPath,
	}
}

// The collapsed "Skimmed · N files" group at the very bottom - the test-fold precedent, but a
// flat group (no nesting). Expand state is per-session (isSkimGroupExpanded).
function appendSkimGroup(build: TreeBuild, skimmedPaths: string[]): void {
	if (!skimmedPaths.length) return
	const isOpen = isSkimGroupExpanded()
	build.rows.push({
		kind: 'skimgrp',
		key: 'skimgrp',
		count: skimmedPaths.length,
		open: isOpen,
		caret: isOpen ? CARET_OPEN : CARET_CLOSED,
	})
	if (!isOpen) return
	const ordered = [...skimmedPaths]
	ordered.sort((a, b) => a.localeCompare(b))
	for (const path of ordered) build.rows.push(skimFileRow(build, path))
}

// Pure data: the flat, ordered list of tree rows the template renders with x-for.
// (Replaces the old buildFileTree HTML-string builder + sync() DOM wiring.)
export function treeRows(): TreeRow[] {
	if (!S.state) return [] // template may evaluate before the initial fetch
	// One O(changes+comments+files) pass for everything each row needs - per-row predicate calls
	// rescanned the global arrays and froze big desks (see flow-index.ts). Built fresh per
	// evaluation so Alpine's dependency tracking stays intact.
	const ix = flowIndex()
	const changedPaths = S.state.files.map(f => f.path)
	const changedIndex = new Map(S.state.files.map((f, i) => [f.path, i]))
	// Files out of the main flow (fully skimmed, or pure renames - issue 01/07) leave the main
	// listing and gather in the collapsed group at the bottom - so they don't mark their folders as
	// changed and don't clutter the tree.
	const skimmedPaths = changedPaths.filter(path => ix.outOfFlow.has(path))
	const skimmedSet = new Set(skimmedPaths)
	// A reviewed file must always appear, even if it isn't in the project listing (a new/
	// untracked file, or a stale listing): union the listing with the changed files when
	// showing unchanged; otherwise just the changed files. Fully-skimmed files are held back.
	const listed =
		S.settings.showUnchanged && S.projectFiles.length
			? [...new Set([...S.projectFiles, ...changedPaths])]
			: changedPaths
	const build: TreeBuild = {
		ix,
		rows: [],
		files: S.state.files,
		changedIndex,
		expandedDirs: S.expandedDirs,
		collapsedDirs: S.collapsedDirs,
		stagedFiles: S.state.stagedFiles,
	}
	const root = emptyNode('', '')
	for (const path of listed) {
		if (skimmedSet.has(path)) continue
		insertFile(root, path, changedIndex.get(path))
	}
	root.files = foldTestFiles(root, S.state.stagedFiles)
	walk(build, root, 0)
	appendSkimGroup(build, skimmedPaths)
	return build.rows
}

// Layout classes were toggled inside the old sync(); render() calls this now.
export function applyLayoutClasses(): void {
	document.body.classList.toggle('single', (S.state?.files.length ?? 0) <= 1)
	document.body.classList.toggle('file-mode', S.state?.mode === 'file')
}

// The sidebar's "active" highlight, patched in place instead of derived in the row models.
// Deriving it made treeRows()/walkthroughRows() depend on S.fileIndex/S.preview/S.overviewOpen,
// so every file switch re-ran both x-fors - thousands of row bindings re-evaluated to move one
// highlight (the dominant per-switch cost on big desks). Same pattern as updateAwaitingDom:
// selectFile calls this directly, and render() re-applies it after Alpine's flush (an rAF later,
// so freshly re-keyed rows get the class back - Alpine's :class diff only removes classes it
// added itself, so this manual class survives binding re-evaluation on reused elements).
export function applyActiveRow(): void {
	for (const el of document.querySelectorAll(
		'#files .node.active, #walk .node.active',
	))
		el.classList.remove('active')
	// No file is "active" on the Overview; a previewed file wins over the indexed review file.
	if (S.overviewOpen) return
	const path = S.preview?.path ?? S.state?.files.at(S.fileIndex)?.path ?? null
	if (!path) return
	for (const key of [`file:${path}`, `test:${path}`])
		for (const el of document.querySelectorAll(
			`.node[data-key="${CSS.escape(key)}"]`,
		))
			el.classList.add('active')
}
