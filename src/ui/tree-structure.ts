import type { TreeFile, TreeNode } from './types'

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
