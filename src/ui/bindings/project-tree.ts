import { toggleRenamedGroup } from '../renames'
import { toggleReviewedGroup } from '../reviewed'
import { S } from '../store'
import { allDirPaths, touchedDirPaths, treeRows } from '../tree'

import type { TreeRow } from '../types'

// The file-tree bindings the Alpine chrome calls as $store.g.*: the row list, folder open/close,
// collapse-all / expand-all, the test-group carets and the two fold groups.
export function installProjectTreeBindings(): void {
	S.treeRows = treeRows
	// Changed folders open by default -> toggle via collapsedDirs; unchanged closed -> expandedDirs.
	S.toggleDir = (full, changed) => {
		const set = changed ? S.collapsedDirs : S.expandedDirs
		if (set.has(full)) set.delete(full)
		else set.add(full)
	}
	// Collapse-all / expand-all from the FILES title; anyOpen drives the button's icon.
	S.treeAnyOpen = () =>
		(S.treeRows?.() ?? []).some(row => row.kind === 'dir' && row.open)
	S.toggleAllDirs = () => {
		// Collapse all -> close every folder. Expand all -> open only folders with a touched file
		// (changes/comments); purely-unchanged folders stay closed.
		if (S.treeAnyOpen?.()) {
			S.collapsedDirs = new Set(allDirPaths())
			S.expandedDirs = new Set()
			return
		}
		S.collapsedDirs = new Set()
		S.expandedDirs = new Set(touchedDirPaths())
	}
	S.toggleTestDir = key => {
		if (S.expandedDirs.has(key)) S.expandedDirs.delete(key)
		else S.expandedDirs.add(key)
	}
	S.toggleRenamedGroup = toggleRenamedGroup
	S.toggleReviewedGroup = toggleReviewedGroup
	// One click handler for every row kind: the Renamed/Reviewed group headers, a folder, an
	// unchanged file (open it as a preview) or a changed one (select it in the review).
	S.rowClick = (row: TreeRow) => {
		if (row.kind === 'foldgrp') {
			if (row.group === 'reviewed') S.toggleReviewedGroup?.()
			else S.toggleRenamedGroup?.()
		} else if (row.kind === 'dir') S.toggleDir?.(row.full, row.changed)
		else if (typeof row.fileIndex === 'number')
			S.selectFile?.(row.fileIndex)
		else S.previewFile?.(row.path)
	}
}
