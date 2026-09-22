import { requireState, S } from '@app/store'
import { toggleRenamedGroup } from '@entities/review/file/renames'
import { toggleReviewedGroup } from '@entities/review/file/reviewed'
import {
	allDirPaths,
	touchedDirPaths,
	treeRows,
} from '@entities/review/file/tree'

import type { TreeRow } from '@entities/review/file/tree-rows'

// The file-tree bindings the Alpine chrome calls as $store.g.*: the row list, folder open/close,
// collapse-all / expand-all, the test-group carets and the two fold groups.

function installTreeRows(): void {
	S.treeRows = () =>
		S.state
			? treeRows({
					state: S.state,
					projectFiles: S.projectFiles,
					showUnchanged: S.settings.showUnchanged,
					hideReviewed: S.settings.hideReviewed,
					expandedDirs: S.expandedDirs,
					collapsedDirs: S.collapsedDirs,
					foldExpanded: S.foldExpanded,
				})
			: []
	// Changed folders open by default -> toggle via collapsedDirs; unchanged closed -> expandedDirs.
	S.toggleDir = (full, changed) => {
		const set = changed ? S.collapsedDirs : S.expandedDirs
		if (set.has(full)) set.delete(full)
		else set.add(full)
	}
}

function installDirToggles(): void {
	// Collapse-all / expand-all from the FILES title; anyOpen drives the button's icon.
	S.treeAnyOpen = () =>
		(S.treeRows?.() ?? []).some(row => row.kind === 'dir' && row.open)
	S.toggleAllDirs = () => {
		// Collapse all -> close every folder. Expand all -> open only folders with a touched file
		// (changes/comments); purely-unchanged folders stay closed.
		if (S.treeAnyOpen?.()) {
			S.collapsedDirs = new Set(
				allDirPaths({
					state: requireState(),
					projectFiles: S.projectFiles,
					showUnchanged: S.settings.showUnchanged,
					hideReviewed: S.settings.hideReviewed,
					expandedDirs: S.expandedDirs,
					collapsedDirs: S.collapsedDirs,
					foldExpanded: S.foldExpanded,
				}),
			)
			S.expandedDirs = new Set()
			return
		}
		S.collapsedDirs = new Set()
		S.expandedDirs = new Set(touchedDirPaths(requireState()))
	}
	S.toggleTestDir = key => {
		if (S.expandedDirs.has(key)) S.expandedDirs.delete(key)
		else S.expandedDirs.add(key)
	}
}

function installGroupToggles(): void {
	S.toggleRenamedGroup = () => {
		toggleRenamedGroup(S.foldExpanded)
	}
	S.toggleReviewedGroup = () => {
		toggleReviewedGroup(S.foldExpanded)
	}
}

// One click handler for every row kind: the Renamed/Reviewed group headers, a folder, an
// unchanged file (open it as a preview) or a changed one (select it in the review).
function installRowClick(): void {
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

export function installProjectTreeBindings(): void {
	installTreeRows()
	installDirToggles()
	installGroupToggles()
	installRowClick()
}
