// File-tree rows: pure data the project tree's x-for template renders. Built by
// tree.ts per evaluation - display state only, never persisted.
import type { FileReviewState } from '../model'

export type DirRow = {
	kind: 'dir'
	key: string
	depth: number
	name: string
	cls: string
	// Inline `--depth:N` custom property - .node derives padding + indent guides from it.
	style: string
	full: string
	dirCaret: string
	open: boolean
	changed: boolean
}

export type FileRow = {
	kind: 'file' | 'test'
	key: string
	depth: number
	name: string
	cls: string
	style: string
	path: string
	fileIndex: number | undefined
	testToggle: boolean
	testKey: string
	testCaret: string
	changeType: 'new' | 'modified' | 'deleted' | null
	// Single review-state badge (null = unchanged file / showing the test caret instead).
	state: FileReviewState | null
	// Pure rename (issue 01): the old path, shown as a "← old" arrow in the Renamed group.
	movedFrom?: string
}

// The collapsible trailing group of files that left the reviewer's listing: the Renamed group
// (pure renames, issue 01) and - with the hide-reviewed pref on - the Reviewed group
// (fully-approved files the lens distills). Same shape, different label and expand key; `group`
// says which. Its member FileRows follow only while `open`.
export type FoldGroupRow = {
	kind: 'foldgrp'
	key: string
	count: number
	open: boolean
	caret: string
	group: 'renamed' | 'reviewed'
}

export type TreeRow = DirRow | FileRow | FoldGroupRow

// Internal nodes used while building the tree (not rendered directly).
export type TreeFile = {
	name: string
	index: number | undefined
	changed: boolean
	path: string
	tests: TreeFile[]
}
export type TreeNode = {
	name: string
	full: string
	dirs: Map<string, TreeNode>
	files: TreeFile[]
	changed: boolean
}
