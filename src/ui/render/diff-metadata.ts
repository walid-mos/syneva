import {
	currentChanges,
	ensureChangesFromFileDiff,
	syncDisplayAnchors,
} from '../changes'
import { cur, peekContents } from '../contents'
import { D, S } from '../store'

import { distillAccepted } from './distill'
import { parseFileDiff } from './parse-input'
import { replayDecisions } from './replay-decisions'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { LineMap } from '../linemap'
import type { ReviewState } from '../types'
import type { DiffView } from './diff-key'
import type { ParseInput } from './parse-input'

type ReviewFile = ReviewState['files'][number]

// FNV-1a over a string, base36: a cheap stable hash used as @pierre cacheKeys for the old side
// (the new side reuses the server's contentHash). Same content -> same key -> cache hit.
const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619
const HASH_RADIX = 36
// The cacheKey for the empty side of a view-only diff lives with the parse itself (./parse-input.ts),
// which the worker shares with this module.
function ckey(s: string): string {
	let hash = FNV_OFFSET_BASIS
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i)
		hash = Math.imul(hash, FNV_PRIME)
	}
	return (hash >>> 0).toString(HASH_RADIX)
}

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
// separately (annotations).
type MetadataMemo = { diff: FileDiffMetadata; lineMap: LineMap | null }
const METADATA_CAP = 8
// The parse is the file-size-dependent half of the build: jsdiff diffs both sides on the main thread
// (measured 5 ms at 400 lines, 171 ms at 3 700 lines with a quarter rewritten, 1 339 ms at 3 700 lines
// fully rewritten) and it does not depend on anything the reviewer toggles. Keeping it in its own memo
// means an accept/reject on a big file - or the prefetch of that very file - replays on top of the
// parse already paid for instead of running the whole-file diff again.
const PARSE_CAP = 4
const metadataMemo = new Map<string, MetadataMemo>()
const parseMemo = new Map<string, FileDiffMetadata>()

type FileContents = { oldContents: string; newContents: string }

// Parse identity: the two contents (their lengths pin the size the parse pays for), the names (rename
// colouring is metadata, not bytes) and whether the old side is read at all.
function parseKey(
	file: ReviewFile,
	contents: FileContents,
	isViewOnlyDiff: boolean,
): string {
	return [
		isViewOnlyDiff ? 'v' : 'd',
		file.path,
		file.oldPath ?? file.path,
		file.newPath ?? file.path,
		file.contentHash,
		ckey(contents.oldContents),
		contents.oldContents.length,
		contents.newContents.length,
		contents.oldContents === contents.newContents ? 'same' : 'diff',
	].join('\x00')
}

// The parse itself, memoized on parseKey. Everything after it - seeding the change records, replaying
// decisions, distilling accepted bands, syncing anchors - reads the parse and writes store state, so
// several replay results can share one parsed FileDiffMetadata.
function parseCached(
	file: ReviewFile,
	contents: FileContents,
	isViewOnlyDiff: boolean,
): FileDiffMetadata {
	const key = parseKey(file, contents, isViewOnlyDiff)
	const hit = parseMemo.get(key)
	if (hit) {
		// LRU refresh: the key matches the same parse, keep it hot.
		parseMemo.delete(key)
		parseMemo.set(key, hit)
		return hit
	}
	const parsed = parseFileDiff(parseInputFor(file, contents, isViewOnlyDiff))
	rememberParse(key, parsed)
	return parsed
}

// The parse's inputs, built here so a prefetch can hand the SAME payload to a worker
// (render/parse-offload.ts) instead of rebuilding them at the call site.
export function parseInputFor(
	file: ReviewFile,
	contents: FileContents,
	isViewOnlyDiff: boolean,
): ParseInput {
	return {
		isViewOnlyDiff,
		// Old/new display names carry rename info to @pierre, exactly as in parseCached.
		oldName: file.oldPath ?? file.path,
		oldContents: contents.oldContents,
		oldCacheKey: ckey(contents.oldContents),
		newName: file.newPath ?? file.path,
		newContents: contents.newContents,
		// cacheKey lets @pierre reuse its highlighted token AST for the same content across renders (and
		// instances), so re-rendering after a decision - or re-opening a file - doesn't re-tokenize.
		newCacheKey: file.contentHash || ckey(contents.newContents),
	}
}

// The parse memo's write path, shared by parseCached and the off-thread prefetch's seed, so the cap and
// the LRU order stay in one place.
function rememberParse(key: string, parsed: FileDiffMetadata): void {
	parseMemo.set(key, parsed)
	while (parseMemo.size > PARSE_CAP) {
		const oldest = parseMemo.keys().next()
		if (oldest.done) break
		parseMemo.delete(oldest.value)
	}
}

// Whether the pass about to run would parse: the memo is keyed exactly like parseCached's, so an
// answer of "no" is the promise that the next parseMetadata call blocks the main thread on jsdiff.
// The cold-open placeholder (render/placeholder.ts) asks before painting provisional rows.
export function isParseMemoized(file: ReviewFile, view: DiffView): boolean {
	return parseMemo.has(parseKey(file, cur, isViewOnly(view.isPreviewing)))
}

// Everything the rendered structure depends on beyond the parse: the expansion pref, the hide-reviewed
// pref (accepted bands drop, so the same decisions cache different metadata) and the decisions.
function metadataFingerprint(file: ReviewFile, view: DiffView): string {
	const changes = currentChanges()
		.filter(c => c.status !== 'pending')
		.map(c => `${c.id}|${c.status}`)
		.join(',')
	return [
		parseKey(file, cur, isViewOnly(view.isPreviewing)),
		view.isExpandedUnchanged ? 'e' : 'c',
		S.settings.hideReviewed ? 'h' : 'v',
		changes,
	].join('\x00')
}

// Parse+replay once per fingerprint, then hand @pierre the SAME diff reference across
// passes: its reference-equality fast path skips the whole row build, so a revisit (the
// measured revisit cost on a mid-size desk: ~628ms -> the cached-wrapper remount) re-mounts
// painted rows instead of paying the pass again. The memo also carries the D.lineMap the
// replay saved: rebuilds happen only through buildDiffMetadata below.
export function memoizedDiffMetadata(
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
	const viewOnly = isViewOnly(view.isPreviewing)
	const raw = parseCached(file, cur, viewOnly)
	if (viewOnly) {
		D.lineMap = null
		return raw
	}
	ensureChangesFromFileDiff(raw)
	const { diff: replayed, decided } = replayDecisions(raw)
	// The hide-reviewed pref distills accepted bands out of the rendered structure; the
	// line map was rebuilt against the cut layout, so display positions stay exact.
	const cutCount = decided.filter(d => d.status === 'cut').length
	const final = cutCount ? distillAccepted(replayed, decided) : replayed
	syncDisplayAnchors(final)
	return final
}

// Metadata for a file that is NOT the one on screen, built for the pool's prefetch. It deliberately
// skips everything buildDiffMetadata does to the CURRENT render's state: no ensureChangesFromFileDiff
// (that would re-seed the change records the visible file is rendering), no replay, no D.lineMap write.
// Which is also why only files with no decided block are eligible: with nothing to replay, this raw
// parse IS the metadata the render pass will build for that file, so the job it warms is the job the
// renderer adopts on the click - same cacheKey, the server's contentHash.
//
// The contents come from the cache only (contents.ts prefetchContents warms them on navigation); a
// miss returns undefined and the caller tries again on a later pass rather than fetching twice.
export function prefetchableParse(
	file: ReviewFile,
	view: DiffView,
): { contents: FileContents; isViewOnly: boolean } | undefined {
	if (S.state?.decisions?.some(d => d.key.startsWith(`${file.path}:`)))
		return undefined
	const contents = peekContents(file)
	if (!contents) return undefined
	// A whole-file view (a new file, or a preview of an unchanged one) renders one-sided - same rule as
	// isViewOnly above, read against THIS file's contents instead of the current file's.
	const viewOnly =
		view.isPreviewing ||
		(S.state?.mode === 'file' &&
			(contents.oldContents === '' ||
				contents.oldContents === contents.newContents))
	return { contents, isViewOnly: viewOnly }
}

export function prefetchableMetadata(
	file: ReviewFile,
	view: DiffView,
): FileDiffMetadata | undefined {
	const plan = prefetchableParse(file, view)
	if (!plan) return undefined
	// The parse is memoized, so the click that follows this prefetch reuses it instead of diffing the
	// file again.
	return parseCached(file, plan.contents, plan.isViewOnly)
}

// Adopt what the off-thread prefetch parsed: same key (parseKey), same call (parse-input.ts), so this IS
// the parse the next render pass for that file would have paid for on the main thread.
export function seedPrefetchedMetadata(
	file: ReviewFile,
	contents: FileContents,
	isViewOnlyDiff: boolean,
	diff: FileDiffMetadata,
): void {
	rememberParse(parseKey(file, contents, isViewOnlyDiff), diff)
}
