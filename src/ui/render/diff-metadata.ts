import { parseDiffFromFile } from '@pierre/diffs'

import {
	currentChanges,
	ensureChangesFromFileDiff,
	syncDisplayAnchors,
} from '../changes'
import { cur } from '../contents'
import { D, S } from '../store'

import { replayDecisions } from './replay-decisions'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { LineMap } from '../linemap'
import type { ReviewState } from '../types'
import type { DiffView } from './diff-key'

type ReviewFile = ReviewState['files'][number]

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
