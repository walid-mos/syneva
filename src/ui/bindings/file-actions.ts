import {
	currentFileOrNull,
	currentSplittable,
	fileFinished,
	fileObjections,
	fromDisplayLine,
	hasCurrentFile,
} from '../changes'
import { cursorSelection } from '../cursor'
import { approveCurrentFile } from '../decisions'
import { isMarkdownPath } from '../file-summary'
import { setMarkdownTheme } from '../markdown'
import { render } from '../render'
import { applyAppearance } from '../settings'
import { api, D, persistPrefs, S, toast } from '../store'

// The bindings for the current file's view and its sign-off affordances: layout (Split/Stacked,
// rendered/source), the settings panel, the "open in editor" jump, and the floating Approve button.

export function installFileActionBindings(): void {
	installLayoutBindings()
	installSignOffBindings()
}

function installLayoutBindings(): void {
	S.setStyle = style => {
		S.diffStyle = style
		void persistPrefs()
		void render()
	}
	S.setFileView = view => {
		S.fileView = view
		D.fileDiff = null
		void render()
	}
	// Apply + persist all settings: CSS vars (font/size), comment-code theme, and a re-render (the
	// diff reads S.settings.* in render()). Bound to every control's @change.
	S.applySettings = () => {
		void persistPrefs()
		applyAppearance(S.settings)
		// applyAppearance first: setMarkdownTheme's diff-only fallback reads <html data-theme>.
		setMarkdownTheme(S.settings.theme)
		void render()
	}
	S.openSettings = () => {
		S.settingsOpen = true
	}
	S.closeSettings = () => {
		S.settingsOpen = false
	}
}

function installSignOffBindings(): void {
	// Floating sign-off button (mirrors the header's ⇧A action): shown only once the diff is
	// scrolled past its header, and only for a pending changed file - not the Overview, a preview
	// (unchanged, not approvable), or an already-finished file (which offers Reset, not Approve).
	S.approveFile = () => {
		// fabState() hides the button without a current file; keeping the action itself a no-op
		// means it can never reach currentFile()'s throw (same contract as openInEditor below).
		if (!hasCurrentFile()) return
		void approveCurrentFile()
	}
	S.fabState = () => {
		if (S.overviewOpen || S.preview) return null
		const path = S.state?.files[S.fileIndex]?.path
		if (!path || fileFinished(path)) return null
		return fileObjections(path) ? 'changes' : 'clean'
	}
	S.isMarkdownFile = () => {
		const { state } = S
		const file =
			state?.mode === 'file' ? state.files[S.fileIndex] : undefined
		return !!file && isMarkdownPath(file.path)
	}
	S.splitApplies = currentSplittable
	// Jump from the desk into the local editor at the cursor's line. The cursor (and S.selected)
	// hold DISPLAY coordinates - replayed decisions renumber the rendered diff - so convert to the
	// real file line before handing it to an external process.
	S.openInEditor = async () => {
		const file = currentFileOrNull()
		if (!file) {
			toast('No file selected')
			return
		}
		const selection = cursorSelection() ?? S.selected
		const lineNumber = fromDisplayLine(selection.side, selection.lineNumber)
		try {
			const reply = await api<{ ok?: boolean; error?: string }>(
				'/api/open-editor',
				{
					method: 'POST',
					body: JSON.stringify({ path: file.path, lineNumber }),
				},
			)
			const failure = reply.error ?? 'Could not open editor'
			toast(reply.ok ? 'Opened in editor' : failure)
		} catch {
			toast('Could not open editor')
		}
	}
}
