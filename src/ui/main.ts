import AlpineJS from 'alpinejs'

import { installCommentBindings } from './bindings/comment'
import { installDialogBindings } from './bindings/dialogs'
import { installFileActionBindings } from './bindings/file-actions'
import { installGuideBindings } from './bindings/guide-bar'
import { installNavigationBindings } from './bindings/navigate'
import { installProjectTreeBindings } from './bindings/project-tree'
import { invalidateCursorRows } from './cursor'
import { defaultFileView } from './file-summary'
import { hasGuide } from './guide'
import { ensureIcons } from './icons'
import { installKeys } from './keys'
import { setMarkdownTheme } from './markdown'
import { adoptDeskStatus, POLL_INTERVAL_MS, pollState } from './poll'
import { setBaseTitle } from './progress'
import { render } from './render'
import { installPaneResizers } from './resizer'
import { applyAppearance, DEFAULT_SETTINGS } from './settings'
import { api, $, S } from './store'

import type { StateWithStatus } from './poll'
import type { DiffStyle, ReviewState, Settings } from './types'

// The tab's bootstrap: store bindings, Alpine start, the initial fetch, and the few document-level
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
// Keyboard shortcuts: a central scope-aware dispatcher (keys.ts) is the single source of truth.
installKeys()
// The store methods the reactive chrome calls ($store.g.*). Installed before Alpine starts, so the
// first template evaluation already sees them.
installProjectTreeBindings()
installNavigationBindings()
installGuideBindings()
installFileActionBindings()
installCommentBindings()
installDialogBindings()

// Alpine: register the reactive store, then start.
declare global {
	interface Window {
		Alpine?: typeof AlpineJS
	}
}
window.Alpine = AlpineJS
AlpineJS.store('g', S)
AlpineJS.start()

// Init
ensureIcons() // file-tree icon sprite (folder/file/badges/stage)
// Display preferences live in ~/.syneva/settings.json (localStorage is per-origin and the port is
// random, so it can't hold them). Fold the file over the defaults before first paint.
const [prefs, state, tree] = await Promise.all([
	loadPrefs(),
	api<StateWithStatus>('/api/state'),
	api<{ files?: string[] }>('/api/tree'),
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
	const pool = await import('./render/worker-pool')
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
// progress.ts prefixes the title with the review % - hand it the base to prefix.
setBaseTitle(document.title)
S.selected = {
	side: S.state.changes[0]?.side ?? 'additions',
	lineNumber: S.state.changes[0]?.lineNumber ?? 1,
}
const firstFile = S.state.files.at(S.fileIndex)
if (firstFile) S.fileView = defaultFileView(firstFile, S.settings.markdownView)
// With a guide attached, land on the Overview page (the guided entry point) and open the sidebar on
// the user's preferred pane (`w` toggles it per-session from there).
if (hasGuide()) {
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

// Preferences are a preference: an unreachable settings file falls back to the defaults.
type Prefs = { settings?: Partial<Settings>; diffStyle?: DiffStyle }

async function loadPrefs(): Promise<Prefs> {
	try {
		return await api<Prefs>('/api/settings')
	} catch {
		return {}
	}
}

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
