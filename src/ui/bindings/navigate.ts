import { prefetchContents } from '../contents'
import { cursorReset } from '../cursor'
import { defaultFileView } from '../file-summary'
import { hasGuide, nextFileIndex, nextWrapIndex, prevWrapIndex } from '../guide'
import { deferRender, render } from '../render'
import { applyActiveRow } from '../sidebar-dom'
import { api, D, S, toast } from '../store'

import type { FileRow, PreviewFile } from '../types'

// The bindings behind moving around the review: picking a file (tree/walkthrough clicks, keyboard
// steps) and opening an unchanged file for a read-only preview. Every step funnels through
// S.selectFile, so the tree highlight, cursor reset and diff render stay in one place.
export function installNavigationBindings(): void {
	installFileSelection()
	installFileStepping()
}

function installFileSelection(): void {
	// Update the lightweight state synchronously (so the tree active-row + guide bar repaint
	// immediately - the click feels instant), then run the heavier diff render via deferRender,
	// which shows the "Rendering…" indicator only for a cold open of a big file.
	S.selectFile = i => {
		const { state } = S
		if (i < 0 || !state?.files[i]) return // ignore out-of-range selections
		// Narrow-width drawer: opening a file is the drawer's whole purpose, so get it out of the
		// way. The single funnel for tree/walkthrough clicks + next/prev + guide nav; no-op when shut.
		S.treeDrawerOpen = false
		S.overviewOpen = false
		S.preview = null
		S.diffScrolled = false // the new file renders at the top (see render.ts) - hide the floating action
		S.fileIndex = i
		S.fileView = defaultFileView(state.files[i], S.settings.markdownView)
		D.fileDiff = null
		cursorReset() // re-init the line cursor to the new file's first change
		// Move the sidebar highlight in place - switching files no longer rebuilds the row lists
		// (the "active" class left the row models; see applyActiveRow in tree.ts).
		applyActiveRow()
		deferRender()
		// Quietly warm the next file in review order (guide order when guided, else sequential - the
		// exact resolution keyboard nav uses) so the common next-file step never waits on the wire.
		const next = nextFileIndex(i)
		if (next !== null) prefetchContents(state.files[next])
	}
	// Open any repo file (incl. unchanged ones) for read/comment: fetch its contents and show it
	// as a plain view (old === new -> no diff blocks). Comments anchor to it like any file.
	S.previewFile = path => {
		void openPreview(path)
	}
}

async function openPreview(path: string): Promise<void> {
	const preview = await readPreviewFile(path)
	if (!preview) return
	S.overviewOpen = false
	S.preview = preview
	D.fileDiff = null
	cursorReset()
	await render()
}

function installFileStepping(): void {
	// Tree-order file stepping (⇧↑/⇧↓) - walk the file rows as shown in the tree (skip folders),
	// selecting the prev/next one (preview for unchanged files).
	S.treeStep = dir => {
		const fileRows = (S.treeRows?.() ?? []).filter(
			(row): row is FileRow => row.kind !== 'dir',
		)
		if (!fileRows.length) return
		const shown = S.preview?.path ?? S.state?.files[S.fileIndex]?.path
		let i = fileRows.findIndex(row => row.path === shown)
		if (i < 0) i = dir === 1 ? -1 : fileRows.length
		const target = fileRows.at(i + dir)
		if (!target) return
		if (typeof target.fileIndex === 'number')
			S.selectFile?.(target.fileIndex)
		else S.previewFile?.(target.path)
	}
	// Review-order file stepping (⇧←/⇧→) - guide order when guided (or on the Overview), else
	// sequential through the diff's files.
	S.nextFile = () => {
		if (hasGuide() || S.overviewOpen) {
			S.guideNext?.()
			return
		}
		const n = S.fileIndex + 1
		// Off the last file, wrap to the first unreviewed file (else the first file).
		const target = n < (S.state?.files.length ?? 0) ? n : nextWrapIndex()
		if (target !== null) S.selectFile?.(target)
	}
	S.prevFile = () => {
		if (hasGuide() || S.overviewOpen) {
			S.guidePrev?.()
			return
		}
		const p = S.fileIndex - 1
		// Off the first file, wrap to the last unreviewed file (else the last file). Without a guide
		// there's no Overview to step back into, so the wrap applies straight from the first file.
		const target = p >= 0 ? p : prevWrapIndex()
		if (target !== null) S.selectFile?.(target)
	}
}

// Fetch an unchanged file for a preview read. A preview is UI-only (never persisted or wired), so it
// carries its single contents inline via previewContents (old === new -> no diff). contentHash is
// unused: previews are never approved.
async function readPreviewFile(path: string): Promise<PreviewFile | null> {
	try {
		const body = await api<{ path: string; contents: string }>(
			`/api/file?path=${encodeURIComponent(path)}`,
		)
		if (typeof body.contents !== 'string') {
			toast('Could not open file')
			return null
		}
		return {
			path,
			hasHunks: false,
			contentHash: '',
			changeKind: 'modified',
			added: 0,
			removed: 0,
			previewContents: body.contents,
		}
	} catch {
		toast('Could not open file')
		return null
	}
}
