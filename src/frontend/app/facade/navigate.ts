import { fetchPreviewFile } from '@entities/review/file/api'
import { prefetchContents } from '@entities/review/file/contents'
import { defaultFileView } from '@entities/review/file/file-summary'
import { hasGuide, navOrder } from '@entities/review/guide/guide'
import { deferRender, render } from '@pages/desk/render'
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
	installSignOffAdvance()
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
		// The sidebar highlight re-derives on the store bump this mutation causes -
		// the React tree repaints it; nothing to patch in place.
		deferRender()
		// Quietly warm the file the next-step will actually open (the active pane's sorting) so
		// the common next-file step never waits on the wire.
		const next = walkthroughActive()
			? nextInWalkthrough(1)
			: (nextInTree(1)?.fileIndex ?? null)
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

// The active pane's sorting: the walkthrough tab walks the guide order (plus the guide's
// "Other" files, in file order); the tree tab walks the tree's own rows. Two sortings, one
// review state - a sign-off in either view approves globally.
const walkthroughActive = (): boolean =>
	hasGuide(GI()) && S.sidebarTab === 'walkthrough'

// Plain next/prev in the walkthrough order - the next file is the next file, period, with
// no unreviewed seek. Cyclic at both ends.
function nextInWalkthrough(dir: 1 | -1): number | null {
	const order = navOrder(GI())
	if (!order.length) return null
	const pos = order.indexOf(S.fileIndex)
	return order[(pos + dir + order.length) % order.length]
}

// Plain next/prev in the tree's file rows (previews included - an unchanged file has no
// index and opens as one). Cyclic at both ends.
function nextInTree(dir: 1 | -1): FileRow | null {
	const rows = (S.treeRows?.() ?? []).filter(
		(row): row is FileRow => row.kind !== 'dir',
	)
	if (!rows.length) return null
	const shown = S.preview?.path ?? S.state?.files[S.fileIndex]?.path
	const pos = rows.findIndex(row => row.path === shown)
	return rows[(pos + dir + rows.length) % rows.length]
}

function installFileStepping(): void {
	// The step is the ACTIVE pane's sorting - tree pane steps tree order, walkthrough pane
	// steps walkthrough order - never a seek. The Overview is the walkthrough's front page:
	// Next enters the first file, Prev lands on the last one.
	S.stepInView = dir => {
		if (S.overviewOpen) {
			if (dir === 1) {
				S.startGuided?.()
				return
			}
			const order = navOrder(GI())
			const last = order.length ? order[order.length - 1] : null
			if (last !== null) S.selectFile?.(last)
			return
		}
		if (walkthroughActive()) {
			const target = nextInWalkthrough(dir)
			if (target !== null) S.selectFile?.(target)
			return
		}
		const row = nextInTree(dir)
		if (!row) return
		if (typeof row.fileIndex === 'number') S.selectFile?.(row.fileIndex)
		else S.previewFile?.(row.path)
	}
	// The keyboard keys and the guide-bar buttons share this one step; the explicit tree-order
	// keys below stay the escape hatch from the walkthrough pane.
	S.nextFile = () => S.stepInView?.(1)
	S.prevFile = () => S.stepInView?.(-1)
	// Tree-order file stepping (⌘⇧↑/⇧↓) - the tree's rows whatever pane is showing. Cyclic,
	// like every other step; previews (unchanged files) open as previews.
	S.treeStep = dir => {
		const row = nextInTree(dir)
		if (!row) return
		if (typeof row.fileIndex === 'number') S.selectFile?.(row.fileIndex)
		else S.previewFile?.(row.path)
	}
}

function installSignOffAdvance(): void {
	// approveCurrentFile's advance: the armed notes flow wins (facade/notes owns it and says
	// whether it jumped), else the next file in the ACTIVE pane's sorting.
	S.afterSignOff = path => {
		if (S.notesAfterSignOff?.(path)) return
		S.stepInView?.(1)
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
