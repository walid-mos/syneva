import type { FlowIndex } from '../change/flow-index'
import type { ReviewState } from '../model'
import type { TreeBuild } from './tree'
import type { FileRow, TreeFile, TreeNode } from './tree-rows'

type ReviewFile = ReviewState['files'][number]

// The caret glyphs the tree/walkthrough templates render for an open/closed branch. Lived
// in tree.ts before the reviewed-group builder moved beside them in reviewed.ts.
export const CARET_OPEN = '▾'
export const CARET_CLOSED = '▸'

// A sibling test file (`<name>.test.ts`, `.spec` too, any extension) folds under its `<name>.ts`
// parent, so it shows under the parent's caret instead of taking a row of its own.
const TEST_FILE_NAME = /^(?<base>.*)\.(?:test|spec)(?<extension>\.[^.]+)$/

// The file a test/spec file belongs to (`lib/a.test.ts` → `lib`'s `a.ts`), or null when the name
// isn't a test file.
function testParentName(fileName: string): string | null {
	const match = TEST_FILE_NAME.exec(fileName)
	const { groups } = match ?? {}
	if (!groups) return null
	return `${groups.base}${groups.extension}`
}

export function emptyNode(name: string, full: string): TreeNode {
	return { name, full, dirs: new Map(), files: [], changed: false }
}

// Insert one path into the tree, creating the directories it sits in. `index` is the file's
// position in the review (absent for an unchanged project file).
export function insertFile(
	root: TreeNode,
	path: string,
	index: number | undefined,
): void {
	const parts = path.split('/').filter(Boolean)
	const stack = [root]
	let node = root
	for (const part of parts.slice(0, -1)) {
		const existing = node.dirs.get(part)
		const dir =
			existing ??
			emptyNode(part, node.full ? `${node.full}/${part}` : part)
		if (!existing) node.dirs.set(part, dir)
		node = dir
		stack.push(dir)
	}
	const isChanged = typeof index === 'number'
	// A folder counts as part of the review (open by default) if it holds any reviewed file,
	// staged or not - so staging a file doesn't flip its folder to "unchanged" and collapse it.
	if (isChanged) {
		for (const ancestor of stack) ancestor.changed = true
	}
	node.files.push({
		name: parts.at(-1) ?? path,
		index,
		changed: isChanged,
		path,
		tests: [],
	})
}

// Fold each test file into its parent file's `tests` list, then return the node's remaining
// (unfolded) files for the caller to store back. A changed test keeps its parent flagged until
// the reviewer stages it (staging is the sign-off), so the folder stays "changed" while the test
// still needs attention.
export function foldTestFiles(
	node: TreeNode,
	stagedFiles: string[],
): TreeFile[] {
	const byName = new Map(node.files.map(f => [f.name, f]))
	const folded = new Set<TreeFile>()
	for (const file of node.files) {
		const parentName = testParentName(file.name)
		const parent = parentName ? byName.get(parentName) : undefined
		if (!parent) continue
		parent.tests.push(file)
		if (file.changed && !stagedFiles.includes(file.path))
			parent.changed = true
		folded.add(file)
	}
	for (const child of node.dirs.values())
		child.files = foldTestFiles(child, stagedFiles)
	return node.files.filter(f => !folded.has(f))
}

// Everything one treeRows() evaluation needs - the TreeBuild record the row builders pass
// around. (Type-only: tree.ts owns the runtime build loop.)
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
export type FileSignals = {
	state: FileRow['state']
	changeType: FileRow['changeType']
	/** the name still reads as "changed" (cyan): a pending changed file, or a pending child test */
	isChangedish: boolean
	/** the test caret is shown instead of the state badge */
	showsTestToggle: boolean
	/** the test list is expanded under this file */
	areTestsOpen: boolean
}

export function fileSignals(
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

// A file showing its test caret reads through the caret instead of the review-state badge.
export function stateBadge(signals: FileSignals): FileRow['state'] {
	if (signals.showsTestToggle) return null
	return signals.state
}
