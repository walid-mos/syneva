import { createRoot } from 'react-dom/client'

import { installCommentBindings } from '@app/facade/comment-thread'
import { installDialogBindings } from '@app/facade/dialogs'
import { installGuideBindings } from '@app/facade/guide-bar'
import { installNavigationBindings } from '@app/facade/navigate'
import { installProjectTreeBindings } from '@app/facade/project-tree'
import { installFileActionBindings } from '@app/facade/review-header'
import { installKeys } from '@app/keys'
import { adoptDeskStatus, POLL_INTERVAL_MS, pollState } from '@app/poll'
import { installPaneResizers } from '@app/resizer'
import { fetchState } from '@entities/review/api'
import { fetchTree } from '@entities/review/file/api'
import { repoBlobUrl } from '@entities/review/file/api'
import { defaultFileView } from '@entities/review/file/file-summary'
import { hasGuide } from '@entities/review/guide/guide'
import { fetchPrefs } from '@entities/settings/api'
import { applyAppearance, DEFAULT_SETTINGS } from '@entities/settings/settings'
import { bindDeskCtx } from '@pages/desk/context'
import { deferRender, render } from '@pages/desk/render'
import { $ } from '@shared/lib/dom'
import { setMarkdownTheme } from '@shared/markdown'
import { configureMarkdownRuntime } from '@shared/markdown/runtime-config'
import { ensureIcons } from '@shared/ui/icons'
import { bindChromeCtx } from '@widgets/chrome/context'
import { setBaseTitle } from '@widgets/chrome/react/top-bar'
import { bindDiffCtx } from '@widgets/diff-view/context'
import { invalidateCursorRows } from '@widgets/diff-view/cursor'
import { D } from '@widgets/diff-view/runtime'

import { bindFeaturePorts } from './feature-ctx'
import { App } from './react/app'
import { persist, requireState, toast } from './store'
import { S } from './store'

import type { GuideInputs } from '@entities/review/guide/guide'
import type { ReviewState } from '@entities/review/model'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: S.state,
	fileIndex: S.fileIndex,
	hideReviewed: S.settings.hideReviewed,
	progressBy: S.settings.progressBy,
	foldExpanded: S.foldExpanded,
})

// The tab's bootstrap: store bindings, the React root, the initial fetch, and the few document-level
// listeners. Everything with real behaviour lives in the modules this wires together.

// The pr title is the ref, truncated so a long branch name can't dominate the tab strip.
const REF_TITLE_MAX = 32
// Scrolling the diff past its header reveals the floating Approve button.
const FAB_REVEAL_SCROLL_PX = 140
// Idle budget for the pool warm-up: `requestIdleCallback` runs when the main thread has slack, and
// the timeout is the safety net so a busy page still boots the pool before the first file opens.
const WARM_IDLE_TIMEOUT_MS = 400
// Browsers without requestIdleCallback (Safari < 15.4): a plain delay lands in the same gap.
const WARM_FALLBACK_DELAY_MS = 120

installPaneResizers()
// Bind the features' use-case context before any binding that can invoke a feature action.
bindFeaturePorts()
// Bind the page/widget contexts before the React root mounts and before any render or action can
// run: every desk render pass, diff-island mutation and chrome read goes through these
// seams, and each throws until app composition has bound it (see the per-context modules).
// S is bound as the reactive proxy itself (mutations stay observable); D stays the plain
// holder (@pierre's element-identity checks break on a reactive proxy).
bindDeskCtx({ S, D, requireState, deferRender })
bindDiffCtx({ S, D, requireState, deferRender, persist, toast })
bindChromeCtx(S)
// Keyboard shortcuts: a central scope-aware dispatcher (keys.ts) is the single source of truth.
installKeys()
// The store methods the chrome call. Installed before the React tree mounts, so the
// first template evaluation already sees them.
installProjectTreeBindings()
installNavigationBindings()
installGuideBindings()
installFileActionBindings()
installCommentBindings()
installDialogBindings()

// The React tree: mounted right after the contexts and facade bindings are in place, so
// the shell (and the engine containers inside DiffArea) exist before the resizer and the
// first render pass touch them. The store starts with state=null; the chrome tolerates it
// and fills in when the initial fetch adopts.
createRoot($('root')).render(<App />)

// Init
ensureIcons() // file-tree icon sprite (folder/file/badges/stage)
// The shared markdown loader is stateless infrastructure: it reads the live theme, repaints
// through the render funnel, and toasts on failure - all composed here, the only app module.
configureMarkdownRuntime({
	getTheme: () => S.settings.theme,
	onLoaded: () => void render(),
	onLoadError: () =>
		toast('Markdown rendering could not load. Reopen the file to retry.'),
	// The blob route is named only by the review-file API boundary - shared markdown
	// receives the resolver injected here (repo-relative images rewrite to /api/blob).
	repoImageSrc: repoBlobUrl,
})
// Display preferences live in ~/.syneva/settings.json (localStorage is per-origin and the port is
// random, so it can't hold them). Fold the file over the defaults before first paint.
const [prefs, state, tree] = await Promise.all([
	fetchPrefs(),
	fetchState(),
	fetchTree(),
])
S.settings = { ...DEFAULT_SETTINGS, ...prefs.settings }

if (prefs.diffStyle === 'split' || prefs.diffStyle === 'unified')
	S.diffStyle = prefs.diffStyle
applyAppearance(S.settings) // font + size before first paint
setMarkdownTheme(S.settings.theme)
// Warm the token pool on the next idle slot: the boot is the only long main-thread task that can run
// before the diff exists (62-110 ms of highlighter engine work, of which the chunk fetch is 5 ms), and
// the renderer cannot ask for tokens until it settles, so the idle slot between the state fetch and
// the first render pass hides it. Deliberately NOT scheduled before the settings/state fetch:
// measured twice, that pulls the boot and the 5 worker boots into the parse, the paint then slips
// enough to cost more than the boot it saves (medium: painted 510 ms vs 203, first colour 825 vs 684),
// so the earlier placement is recorded as a rejected run in test/benchmarks/history.json. The pool is
// reached through a dynamic import because its graph (manager -> @pierre + the highlighter chunks)
// must stay out of the initial bundle; scripts/bundle-budget.mjs enforces that boundary.
const warmPoolBoot = async (): Promise<void> => {
	const pool = await import('@widgets/diff-view/worker-pool')
	pool.warmPoolBoot()
}
const warmOnIdle = (): void => void warmPoolBoot()
if (typeof requestIdleCallback === 'function')
	requestIdleCallback(warmOnIdle, { timeout: WARM_IDLE_TIMEOUT_MS })
else setTimeout(warmOnIdle, WARM_FALLBACK_DELAY_MS)
S.state = adoptDeskStatus(state)
S.projectFiles = tree.files ?? []
S.lastBaseDiffHash = S.state.baseDiffHash
// Tab title: name the desk so multiple desks are distinguishable in the browser.
const deskName = readDeskName(S.state)
if (deskName) document.title = `Syneva - ${deskName}`
// The top bar's progress label prefixes the title with the review % - hand it the base.
setBaseTitle(document.title)
S.selected = {
	side: S.state.changes[0]?.side ?? 'additions',
	lineNumber: S.state.changes[0]?.lineNumber ?? 1,
}
const firstFile = S.state.files.at(S.fileIndex)
if (firstFile) S.fileView = defaultFileView(firstFile, S.settings.markdownView)
// With a guide attached, land on the Overview page (the guided entry point) and open the sidebar on
// the user's preferred pane (`w` toggles it per-session from there).
if (hasGuide(GI())) {
	S.overviewOpen = true
	S.sidebarTab =
		S.settings.sidebarDefault === 'walkthrough' ? 'walkthrough' : 'tree'
}
void render()
// Reveal the floating Approve button once the diff scrolls past its (non-sticky) header. #diff is
// the persistent scroll container (x-ignore), so this listener is attached once and survives every
// re-render/file switch.
$('diff').addEventListener('scroll', () => {
	S.diffScrolled = $('diff').scrollTop > FAB_REVEAL_SCROLL_PX
})
// A resize reflows line heights (and wrap), so the cursor's cached row measurements no longer hold -
// drop the cache so the next navigation re-measures. (Scroll doesn't: the cached tops are
// content-relative, so scrolling leaves the row list unchanged - see cursor.ts.)
window.addEventListener('resize', invalidateCursorRows)
setInterval(() => void pollState(), POLL_INTERVAL_MS)

// Repo mode -> repo folder; file mode -> file name; pr mode -> the (truncated) ref.
function readDeskName(review: ReviewState): string {
	if (review.mode === 'file') return lastPathSegment(review.target)
	if (review.mode === 'pr') {
		const ref = review.target ?? review.session
		return ref.length > REF_TITLE_MAX
			? `${ref.slice(0, REF_TITLE_MAX)}…`
			: ref
	}
	return lastPathSegment(review.root)
}

function lastPathSegment(path: string | undefined): string {
	return path?.replace(/\/+$/, '').split('/').pop() ?? ''
}
