import { fetchPreviewFile } from '@entities/review/file/api'
import { prefetchContents } from '@entities/review/file/contents'
import { defaultFileView } from '@entities/review/file/file-summary'
import {
	hasGuide,
	nextFileIndex,
	nextWrapIndex,
	prevWrapIndex,
} from '@entities/review/guide/guide'
import { deferRender, render } from '@pages/desk/render'
import { applyActiveRow } from '@widgets/chrome/sidebar-dom'
import { cursorReset } from '@widgets/diff-view/cursor'
import { D } from '@widgets/diff-view/runtime'

import { S, toast } from '../store'

import type { FileRow } from '@entities/review/file/tree-rows'
import type { GuideInputs } from '@entities/review/guide/guide'
import type { PreviewFile } from '@entities/review/model'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: S.state,
	fileIndex: S.fileIndex,
	hideReviewed: S.settings.hideReviewed,
	progressBy: S.settings.progressBy,
	foldExpanded: S.foldExpanded,
})

// The bindings behind moving around the review: picking a file (tree/walkthrough clicks, keyboard
// steps) and opening an unchanged file for a read-only preview. Every step funnels through
// S.selectFile, so the tree highlight, cursor reset and diff render stay in one place.
export function installNavigationBindings(): void {
	installFileSelection()
	installFileStepping()
}

// The navigation generation: bumped by every selection that replaces the rendered file
// (S.selectFile) and by every preview request. An in-flight preview whose token is no
// longer current is discarded, so a late response can't overwrite a newer selection.
let navGeneration = 0

function installFileSelection(): void {
	// Update the lightweight state synchronously (so the tree active-row + guide bar repaint
	// immediately - the click feels instant), then run the heavier diff render via deferRender,
	// which shows the "Rendering…" indicator only for a cold open of a big file.
	S.selectFile = i => {
		const { state } = S
		if (i < 0 || !state?.files[i]) return // ignore out-of-range selections
		navGeneration++ // invalidate any in-flight preview for the file being left
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
		const next = nextFileIndex(GI(), i)
		if (next !== null)
			prefetchContents(state.files[next], S.loadedOversized)
	}
	// Open any repo file (incl. unchanged ones) for read/comment: fetch its contents and show it
	// as a plain view (old === new -> no diff blocks). Comments anchor to it like any file.
	S.previewFile = path => {
		void openPreview(path)
	}
}

async function openPreview(path: string): Promise<void> {
	const gen = ++navGeneration
	const preview = await readPreviewFile(path)
	// A newer selection (file pick or preview) happened while this request was in flight:
	// drop the stale response instead of rendering the wrong file.
	if (gen !== navGeneration) return
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
		if (hasGuide(GI()) || S.overviewOpen) {
			S.guideNext?.()
			return
		}
		const n = S.fileIndex + 1
		// Off the last file, wrap to the first unreviewed file (else the first file).
		const target =
			n < (S.state?.files.length ?? 0) ? n : nextWrapIndex(GI())
		if (target !== null) S.selectFile?.(target)
	}
	S.prevFile = () => {
		if (hasGuide(GI()) || S.overviewOpen) {
			S.guidePrev?.()
			return
		}
		const p = S.fileIndex - 1
		// Off the first file, wrap to the last unreviewed file (else the last file). Without a guide
		// there's no Overview to step back into, so the wrap applies straight from the first file.
		const target = p >= 0 ? p : prevWrapIndex(GI())
		if (target !== null) S.selectFile?.(target)
	}
}

// Fetch an unchanged file for a preview read. A preview is UI-only (never persisted or wired), so it
// carries its single contents inline via previewContents (old === new -> no diff). contentHash is
// unused: previews are never approved.
async function readPreviewFile(path: string): Promise<PreviewFile | null> {
	try {
		const body = await fetchPreviewFile(path)
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
