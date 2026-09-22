// The diff parse itself: the ONE definition shared by the main thread (diff-metadata.ts parseCached) and
// the worker (worker/diff-token-worker.ts). The prefetch parses off-thread and the click must adopt exactly
// that parse, so the inputs and the call live here instead of in two lookalike copies that could drift.
//
// Deliberately store-free: the worker bundle imports this module, and pulling the store in would drag the
// whole review graph along with it.
import { parseDiffFromFile } from '@pierre/diffs'

import type { FileDiffMetadata } from '@pierre/diffs'

// The cacheKey for the empty side of a view-only diff (a preview reads as one-sided content).
export const EMPTY_SIDE_KEY = '∅'

// Plain data on purpose: this is also the wire payload of a `parse-diff` worker request.
export type ParseInput = {
	isViewOnlyDiff: boolean
	oldName: string
	oldContents: string
	oldCacheKey: string
	newName: string
	newContents: string
	newCacheKey: string
}

export function parseFileDiff(input: ParseInput): FileDiffMetadata {
	// cacheKey lets @pierre reuse its highlighted token AST for the same content across renders (and
	// instances), so re-rendering after a decision - or re-opening a file - doesn't re-tokenize.
	const newSide = {
		name: input.newName,
		contents: input.newContents,
		cacheKey: input.newCacheKey,
	}
	return input.isViewOnlyDiff
		? parseDiffFromFile(
				{ name: input.newName, contents: '', cacheKey: EMPTY_SIDE_KEY },
				newSide,
			)
		: parseDiffFromFile(
				{
					name: input.oldName,
					contents: input.oldContents,
					cacheKey: input.oldCacheKey,
				},
				newSide,
			)
}
