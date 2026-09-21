import type { PreviewFile, ReviewState } from '@entities/review/model'
import type { Settings } from '@entities/settings/model'

// The chrome widgets' view context (progress strip, sidebar highlight, dialogs). Chrome
// reaches the app-owned reactive store only through this seam (bound once by app
// composition) - no chrome module imports @app.
export interface ChromeStoreView {
	state: ReviewState | null
	settings: Settings
	fileIndex: number
	foldExpanded: Set<string>
	preview: PreviewFile | null
	overviewOpen: boolean
	rendering: boolean
	awaitingAgent: boolean
	// Polling stores the activity line as a plain string (see app/poll.ts adoptLiveness);
	// the widget view mirrors that representation, not the DeskStatus object.
	agentActivity: string | null
	agentListening: boolean
	queuedQuestions: number
	queuedReviews: number
	lastBaseDiffHash: string | null
}

let ctx: { S: ChromeStoreView } | null = null

export function bindChromeCtx(bound: ChromeStoreView): void {
	ctx = { S: bound }
}

export function chromeCtx(): { S: ChromeStoreView } {
	if (!ctx)
		throw new Error('chrome context read before app composition bound it')
	return ctx
}
