import { FileDiff, parseDiffFromFile } from '@pierre/diffs'

import { annotations, renderAnnotation } from '../annotations'
import {
	currentChanges,
	currentComments,
	currentSplittable,
	ensureChangesFromFileDiff,
	replayDecisions,
	syncDisplayAnchors,
} from '../changes'
import { cur } from '../contents'
import { cursorResync, invalidateCursorRows } from '../cursor'
import { revealThreadLines } from '../expand'
import { currentGuideEntry } from '../guide'
import {
	attachDiffSelectionHandlers,
	handleDiffSelection,
	handleLineNumberClick,
} from '../selection'
import { applySkimCollapse, isBlockSkimCollapsed } from '../skim'
import { $, D, S } from '../store'

import { createDiffHeader, headerActions } from './file-header'
import { renderOverviewRuler } from './overview-ruler'
import { renderSignature } from './render-signature'
import { diffWorkerPool, syncPoolRenderOptions } from './worker-pool'

import type { FileDiffMetadata, FileDiffOptions } from '@pierre/diffs'
import type { LineMap } from '../linemap'
import type { AnnotationMeta, ReviewState } from '../types'

type ReviewFile = ReviewState['files'][number]
type DiffEntry = { wrapper: HTMLElement; inst: FileDiff<AnnotationMeta> }

// The view flags every render step shares: `isPreviewing` for a read-only one-sided preview of an
// unchanged file, `isExpandedUnchanged` for the diff's "expand unchanged lines" setting.
export type DiffView = { isPreviewing: boolean; isExpandedUnchanged: boolean }

// The @pierre/diffs island: parse the current file's contents into the diff the reviewer sees
// (decisions replayed), mount it into a cached wrapper, then run the work that needs committed rows.

// How many rendered file instances to keep warm (each holds DOM + @pierre's highlight cache).
// Bench check (2026): 30 entries held ~350-500MB of detached DOM + instance state on a
// mid-size desk (medium fixture: 200MB resident -> 594MB after browsing 34 files), and the
// memory pressure shows up as scroll/switch jank - while a revisit re-render costs roughly
// the same as a cold render anyway (the earlier rows are re-parsed, not reused), so the warm
// cap primarily buys memory. 12 keeps a reviewer's working set (a handful of files revisited
// during a session) warm without pinning the desk for tens of seconds afterward.
const DIFF_CACHE_CAP = 12
// FNV-1a over a string, base36: a cheap stable hash used as @pierre cacheKeys for the old side
// (the new side reuses the server's contentHash). Same content -> same key -> cache hit.
const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619
const HASH_RADIX = 36
// The cacheKey for the empty side of a view-only diff (a preview reads as one-sided content).
const EMPTY_SIDE_KEY = '∅'

function ckey(s: string): string {
	let hash = FNV_OFFSET_BASIS
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i)
		hash = Math.imul(hash, FNV_PRIME)
	}
	return (hash >>> 0).toString(HASH_RADIX)
}

// Identity of a rendered diff for the LRU cache: the current file + every option that changes
// what @pierre renders. deferRender uses this to tell if re-opening a file will be a fast cache
// hit (-> skip the "Rendering…" indicator). Reads currentSplittable(), so call after fileIndex is set.
export function diffKey(file: ReviewFile, view: DiffView): string {
	return JSON.stringify([
		file.path,
		view.isPreviewing,
		currentSplittable() ? S.diffStyle : 'unified',
		view.isExpandedUnchanged,
		view.isPreviewing ? 'none' : S.settings.diffIndicators,
		S.settings.overflow,
		S.settings.hunkSeparators,
		S.settings.lineDiffType,
		S.settings.theme,
		// appearance flips @pierre's themeType, so a cached diff must invalidate on it
		S.settings.appearance,
		!!currentGuideEntry(),
	])
}

// Preview reads as a plain file: remap @pierre's addition styling to its CONTEXT (unchanged)
// styling - row tint, gutter cell bg, and gutter number color all to the neutral context values -
// so a one-sided render of an unchanged file isn't all-green. These must be set INSIDE @pierre's
// shadow (via unsafeCSS below): the context vars they reference only exist there, so a host-level
// override referencing them is invalid and silently reverts.
const PREVIEW_CSS =
	'[data-code]{--diffs-bg-addition-override:var(--diffs-bg-context);--diffs-bg-addition-emphasis-override:var(--diffs-bg-context);--diffs-bg-addition-number-override:var(--diffs-bg-context-gutter);--diffs-fg-number-addition-override:var(--diffs-fg-number)}'

// @pierre renders nothing for a zero-change diff, so a whole-file view (a new file, or a preview -
// an unchanged file the reviewer opened) is shown as the file's content on one side.
function isViewOnly(isPreviewing: boolean): boolean {
	if (isPreviewing) return true
	if (S.state?.mode !== 'file') return false
	return cur.oldContents === '' || cur.oldContents === cur.newContents
}

// The parsed diff @pierre renders, carrying the reviewer's decisions. Changes (identity, raw
// anchors) derive from the raw diff; the rendered diff is the decision-replayed one, so display
// anchors must be re-read from it (resolutions renumber lines - see linemap.ts).
//
// Passing the SAME metadata object back across passes lets @pierre short-circuit its row build
// (reference-equal fileDiff skips the whole reconstruction), so the memo below is also a render
// fast path - on a revisit the cached wrapper re-mounts its already-painted rows.
//
// The memo key covers everything buildDiffMetadata consumes: file identity (paths, contentHash,
// old-side content digest + lengths), the view flags that change the parse, and the non-pending
// decision set (the replay filters pending). Comments are NOT in the scope: they anchor
// separately (annotations), and skim collapse is applied without touching metadata.
type MetadataMemo = { diff: FileDiffMetadata; lineMap: LineMap | null }
const METADATA_CAP = 8
const metadataMemo = new Map<string, MetadataMemo>()

function metadataFingerprint(file: ReviewFile, view: DiffView): string {
	const changes = currentChanges()
		.filter(c => c.status !== 'pending')
		.map(c => `${c.id}|${c.status}`)
		.join(',')
	return [
		view.isPreviewing ? 'p' : 'd',
		view.isExpandedUnchanged ? 'e' : 'c',
		isViewOnly(view.isPreviewing) ? 'v' : 'r',
		file.path,
		file.oldPath ?? file.path,
		file.newPath ?? file.path,
		file.contentHash,
		ckey(cur.oldContents),
		cur.oldContents.length,
		cur.newContents.length,
		changes,
	].join('\x00')
}

// Parse+replay once per fingerprint, then hand @pierre the SAME diff reference across
// passes: its reference-equality fast path skips the whole row build, so a revisit (the
// measured revisit cost on a mid-size desk: ~628ms -> the cached-wrapper remount) re-mounts
// painted rows instead of paying the pass again. The memo also carries the D.lineMap the
// replay saved: rebuilds happen only through buildDiffMetadata below.
function memoizedDiffMetadata(
	file: ReviewFile,
	view: DiffView,
): FileDiffMetadata {
	const fingerprint = metadataFingerprint(file, view)
	const memo = metadataMemo.get(fingerprint)
	if (memo) {
		// LRU refresh: the fingerprint's memo is fresh by definition; keep it hot.
		metadataMemo.delete(fingerprint)
		metadataMemo.set(fingerprint, memo)
		D.lineMap = memo.lineMap
		return memo.diff
	}
	const diff = buildDiffMetadata(file, view)
	metadataMemo.set(fingerprint, { diff, lineMap: D.lineMap })
	while (metadataMemo.size > METADATA_CAP) {
		const oldest = metadataMemo.keys().next()
		if (oldest.done) break
		metadataMemo.delete(oldest.value)
	}
	return diff
}

function buildDiffMetadata(file: ReviewFile, view: DiffView): FileDiffMetadata {
	// Old/new display names carry rename info to @pierre (distinct paths -> rename coloring);
	// they're metadata (oldPath/newPath), not contents, so they stay independent of the bytes.
	const newName = file.newPath ?? file.path
	// cacheKey lets @pierre reuse its highlighted token AST for the same content across renders (and
	// instances), so re-rendering after a decision - or re-opening a file - doesn't re-tokenize.
	const newSide = {
		name: newName,
		contents: cur.newContents,
		cacheKey: file.contentHash || ckey(cur.newContents),
	}
	if (isViewOnly(view.isPreviewing)) {
		D.lineMap = null
		return parseDiffFromFile(
			{ name: newName, contents: '', cacheKey: EMPTY_SIDE_KEY },
			newSide,
		)
	}
	const oldSide = {
		name: file.oldPath ?? file.path,
		contents: cur.oldContents,
		cacheKey: ckey(cur.oldContents),
	}
	const raw = parseDiffFromFile(oldSide, newSide)
	ensureChangesFromFileDiff(raw)
	const replayed = replayDecisions(raw)
	syncDisplayAnchors(replayed)
	return replayed
}

// The @pierre render options for one instance. `renderHeaderMetadata` and `renderCustomHeader`
// are our own header builders (see file-header.ts).
function diffOptions(view: DiffView): FileDiffOptions<AnnotationMeta> {
	const { isPreviewing, isExpandedUnchanged } = view
	return {
		// The code theme is the user's pick regardless of appearance (the settings dropdown groups
		// dark and light themes; mixing is allowed). Both slots get it - themeType only decides
		// which slot @pierre reads plus its own chrome colors, which follow the appearance.
		theme: { dark: S.settings.theme, light: S.settings.theme },
		themeType: S.settings.appearance === 'light' ? 'light' : 'dark',
		diffStyle: currentSplittable() ? S.diffStyle : 'unified',
		diffIndicators: isPreviewing ? 'none' : S.settings.diffIndicators,
		expandUnchanged: isExpandedUnchanged,
		overflow: S.settings.overflow,
		hunkSeparators: S.settings.hunkSeparators,
		lineDiffType: S.settings.lineDiffType,
		enableLineSelection: true,
		renderAnnotation,
		onLineNumberClick: handleLineNumberClick,
		onLineSelectionStart: handleDiffSelection,
		onLineSelectionChange: handleDiffSelection,
		onLineSelected: handleDiffSelection,
		onLineSelectionEnd: handleDiffSelection,
		renderHeaderMetadata: headerActions,
		// @pierre's own post-render signal - fires once the diff rows are committed to the shadow
		// DOM (mount and every update). This is where skim collapse must run: on a COLD mount the
		// render() promise resolves before the rows are queryable, so the afterRender pass finds
		// nothing; onPostRender fires when they exist. (afterRender still runs it too, for the
		// warm/cached path where rows are already present - both are idempotent.)
		onPostRender: (_node, _instance, phase) => {
			// The rendered rows just changed (mount, update, or @pierre's own expandHunk rerender -
			// which never routes through our render()), so the cursor's cached row list is stale.
			invalidateCursorRows()
			if (phase !== 'unmount') applySkimCollapse()
		},
		// @pierre reserves a right-side gutter via `scrollbar-gutter: stable` on the code grid (for
		// a vertical scrollbar it hides) - drop it so rows fill the full width. PREVIEW_CSS (empty
		// unless previewing) neutralizes addition styling to context, in-shadow.
		unsafeCSS: `[data-code]{scrollbar-gutter:auto}${isPreviewing ? PREVIEW_CSS : ''}`,
		renderCustomHeader: createDiffHeader(isPreviewing),
	}
}

// The cached instance for `key`, created on first use. Re-inserting moves it to the most-recently-
// used end; only the wrapper of the active instance is mounted in #diff, the others stay detached
// but referenced, so their DOM + @pierre highlight cache survive.
function acquireEntry(key: string, view: DiffView): DiffEntry {
	const cached = D.diffCache.get(key)
	if (cached) {
		D.diffCache.delete(key)
		D.diffCache.set(key, cached)
		return cached
	}
	const wrapper = document.createElement('div')
	wrapper.className = 'diff-wrap'
	const entry: DiffEntry = {
		wrapper,
		// The pool - the second @pierre constructor argument - moves Shiki tokenization/highlight
		// off the main thread into Workers; a first render returns before rows exist and @pierre
		// re-renders itself when the pool's tokens arrive (its onHighlightSuccess hook). The main
		// instance options still own the chrome, settings, and DOM announcements.
		inst: new FileDiff(diffOptions(view), diffWorkerPool()),
	}
	D.diffCache.set(key, entry)
	return entry
}

// Mount the entry's wrapper as #diff's only child. A same-file re-render skips the replace: it
// would detach and re-attach the wrapper, resetting scroll for no reason.
function mountEntry(host: HTMLElement, entry: DiffEntry): boolean {
	const isNewMount =
		host.firstElementChild !== entry.wrapper || host.childElementCount !== 1
	if (isNewMount) host.replaceChildren(entry.wrapper)
	return isNewMount
}

// The last pass that fully painted a diff (see the no-op guard in renderDiffInstance). The
// guard self-corrects on detach: it also requires the recorded instance's wrapper to still be
// mounted, so overview/markdown/replacement detours bust it without bookkeeping here.
let lastRenderedKey: string | null = null
let lastRenderedSignature: string | null = null

// Evict least-recently-used instances beyond the cap, keeping the active one.
function evictEntries(active: DiffEntry): void {
	while (D.diffCache.size > DIFF_CACHE_CAP) {
		const oldest = D.diffCache.keys().next()
		if (oldest.done) return
		const evicted = D.diffCache.get(oldest.value)
		D.diffCache.delete(oldest.value)
		if (evicted && evicted !== active) {
			evicted.inst.cleanUp()
			evicted.wrapper.remove()
		}
	}
}

// Work that needs the rows to exist. Skim collapse runs synchronously (before paint) so there is
// no expand-then-collapse flash; the rest waits for a frame so the rows have laid out.
function afterRender(key: string, view: DiffView): void {
	const { isPreviewing, isExpandedUnchanged } = view
	if (!isPreviewing) {
		applySkimCollapse()
		// Unfold collapsed regions hiding an open comment thread (once per rendered diff).
		revealThreadLines(key)
	}
	setTimeout(() => attachDiffSelectionHandlers(), 0)
	// The overview ruler only makes sense when the whole file is shown (expand mode) and there are
	// real changes (not a preview).
	if (!isPreviewing && isExpandedUnchanged)
		requestAnimationFrame(() => renderOverviewRuler())
	// Repaint the keyboard line cursor once rows have laid out (init to first change on a fresh
	// file, else keep the same logical line).
	requestAnimationFrame(() => cursorResync())
}

export function renderDiffInstance(file: ReviewFile, view: DiffView): void {
	// The pool requires current token settings (the worker bakes them into the returned tokens).
	syncPoolRenderOptions()
	const key = diffKey(file, view)
	// No-op guard: a data+options pair identical to the last painted pass re-renders the same
	// rows (every poll tick with merged agent comments, or a re-derived change list). Skip the
	// parse/replay/inst.render entirely - calling render() again must stay cheap and SHOULD
	// converge. Poll/selection renders pass through here; real decisions never hit the guard
	// (they change the signature).
	const signature = renderSignature(
		file,
		view,
		// Pure-digest projection: the store side effects (current* filters, the skim outcome)
		// stay here; the signature itself is data-in data-out.
		currentChanges().map(c => ({
			id: c.id,
			status: c.status,
			skimCollapsed: isBlockSkimCollapsed(c),
		})),
		{ comments: currentComments(), composer: S },
	)
	const host = $('diff')
	const stillMounted =
		key === lastRenderedKey &&
		signature === lastRenderedSignature &&
		// And the painted rows are actually the ones on screen: a replacement view (overview,
		// markdown, ...) or detach may have emptied #diff in between - re-render then.
		D.diffCache.get(key)?.wrapper === host.firstElementChild
	if (stillMounted) return
	// Metadata memo: an identical fingerprint hands @pierre the same diff reference it
	// already rendered, engaging its reference-equality fast path (no full row rebuild) so a
	// revisit re-mounts painted rows instead of paying parse+replay+rebuild again.
	// Miss → parse+replay once, memoized.
	const metadata = memoizedDiffMetadata(file, view)
	D.fileDiff = metadata
	const entry = acquireEntry(key, view)
	D.instance = entry.inst
	const mountedNew = mountEntry(host, entry)
	entry.inst.setLineAnnotations(annotations())
	entry.inst.render({
		fileDiff: metadata,
		containerWrapper: entry.wrapper,
		lineAnnotations: annotations(),
	})
	// A genuine file/view switch starts at the top. #diff is the persistent scroll container, so
	// replaceChildren preserves its previous scrollTop - a tall next file would otherwise open
	// mid-scroll. A same-file re-render (a decision applied) skips this and keeps its scroll.
	if (mountedNew) host.scrollTop = 0
	afterRender(key, view)
	evictEntries(entry)
	// Recorded only after the render landed: a mid-pass throw leaves the guard unaware, so the
	// next pass re-renders instead of trusting half-finished state.
	lastRenderedKey = key
	lastRenderedSignature = signature
}
