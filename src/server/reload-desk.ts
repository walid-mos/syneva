import { validateGuide } from '../guide.js'
import { buildReviewState } from '../state/build.js'
import { parsedDiffOf } from '../state/diff-source.js'
import { resolveMovedFrom, resolveSkim } from '../state/guide-resolve.js'
import { hash } from '../state/identity.js'
import { mergeReviewState, readStagedSnapshot } from '../state/reconcile.js'

import type { DiffFile, Guide, ReviewState } from '../types.js'

export type ReloadOutcome =
	| { kind: 'reloaded'; baseDiffHash: string }
	| { kind: 'empty'; baseDiffHash: string }
	| { kind: 'invalid-guide'; reason: string }

// Re-diff the review and fold it into the live state so the open desk reflects the agent's edits
// without a restart. Rebuilds using the stored mode params; an optional { guide } in the body swaps
// the attached guide in the same round-trip - the multi-round path: regenerate the guide, reload,
// same tab. Nothing is committed to the live state until every guide validation has passed.
export async function reloadDesk(
	state: ReviewState,
	persist: () => Promise<string>,
	rawBody: string,
): Promise<ReloadOutcome> {
	const postedGuide = reloadGuide(rawBody)
	let validatedGuide: Guide | undefined
	if (postedGuide.present) {
		const validation = validateGuide(postedGuide.guide)
		if (!validation.ok)
			return { kind: 'invalid-guide', reason: validation.reason }
		validatedGuide = validation.guide
	}
	const base = await rebuildBase(state)
	if (!base) return await reloadEmpty(state, persist)
	const moves = applyDeclaredMoves(base, validatedGuide, state.guide)
	if (!moves.ok) return { kind: 'invalid-guide', reason: moves.reason }
	const merged = await mergeReviewState(base, state)
	const guide = mergeGuide(merged, validatedGuide, parsedDiffOf(base))
	if (guide.kind === 'rejected')
		return { kind: 'invalid-guide', reason: guide.reason }
	Object.assign(state, merged)
	if (guide.guide) Object.assign(state, { guide: guide.guide })
	Object.assign(state, await readStagedSnapshot(state))
	await persist()
	return { kind: 'reloaded', baseDiffHash: state.baseDiffHash }
}

// The `guide` field of the reload body, if it carries one. A body that is empty, non-JSON, or has no
// `guide` key means "keep the guide I have" - legacy callers post nothing and the CLI omits the key.
// `present` is explicit because `guide: null` is a posted (invalid) guide, not an absent one.
type ReloadGuide = { present: true; guide: unknown } | { present: false }

function reloadGuide(rawBody: string): ReloadGuide {
	if (!rawBody) return { present: false }
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return { present: false } // tolerate empty/non-JSON bodies (legacy callers)
	}
	if (typeof parsed !== 'object' || parsed === null || !('guide' in parsed))
		return { present: false }
	return { present: true, guide: parsed.guide }
}

async function rebuildBase(state: ReviewState): Promise<ReviewState | null> {
	return await buildReviewState(state.root, {
		mode: state.mode,
		session: state.session,
		staged: state.staged,
		path: state.mode === 'file' ? state.target : undefined,
		target: state.mode === 'pr' ? state.target : undefined,
		base: state.mode === 'pr' ? state.base : undefined,
	})
}

// An empty rebuild keeps the desk up with an empty diff (whether to open an empty desk at all is the
// startup decision). It deliberately does NOT run mergeReviewState/readStagedSnapshot reconciliation -
// that divergence predates this cleanup and is preserved here.
async function reloadEmpty(
	state: ReviewState,
	persist: () => Promise<string>,
): Promise<ReloadOutcome> {
	Object.assign(state, {
		files: [],
		changes: [],
		rawDiff: '',
		baseDiffHash: hash(''),
	})
	await persist()
	return { kind: 'empty', baseDiffHash: state.baseDiffHash }
}

// Guide-declared moves (movedFrom) must merge into `base` BEFORE reconciliation, so a merged pair's
// distinct paths drive mergeReviewState's rename migration (issue 01). A newly posted guide is strict
// (reject the reload, naming the entry; the desk stays untouched because nothing is committed yet); a
// carried-forward guide is lenient (an unresolvable move drops to delete+add).
function applyDeclaredMoves(
	base: ReviewState,
	postedGuide: Guide | undefined,
	carriedGuide: Guide | undefined,
): { ok: true } | { ok: false; reason: string } {
	if (postedGuide)
		return mergeDeclaredMoves(base, postedGuide, { strict: true })
	if (carriedGuide)
		return mergeDeclaredMoves(base, carriedGuide, { strict: false })
	return { ok: true }
}

function mergeDeclaredMoves(
	base: ReviewState,
	guide: Guide,
	opts: { strict: boolean },
): { ok: true } | { ok: false; reason: string } {
	const moved = resolveMovedFrom(base, guide, opts)
	if (!moved.ok) return { ok: false, reason: moved.reason }
	if (moved.merged) Object.assign(base, moved.merged)
	return { ok: true }
}

type GuideMerge =
	| { kind: 'merged'; guide?: Guide }
	| { kind: 'rejected'; reason: string }

// Fold the guide into the merged candidate and resolve its skim spans against the just-rebuilt diff.
// A posted guide replaces the carried one, stamped with the new baseDiffHash so it isn't born stale,
// and is validated strictly; a carried-forward guide re-resolves leniently - stale spans drop, they
// never fail a reload (see resolveSkim's strict/lenient split). The guide is returned rather than
// assigned so the candidate stays uncommitted until every check has passed.
function mergeGuide(
	merged: ReviewState,
	postedGuide: Guide | undefined,
	parsed: DiffFile[],
): GuideMerge {
	if (postedGuide) {
		const guide = { ...postedGuide, baseDiffHash: merged.baseDiffHash }
		const rejection = resolveGuideSkim(merged, guide, parsed, {
			strict: true,
		})
		if (rejection) return { kind: 'rejected', reason: rejection }
		return { kind: 'merged', guide }
	}
	if (merged.guide)
		resolveGuideSkim(merged, merged.guide, parsed, { strict: false })
	return { kind: 'merged' }
}

function resolveGuideSkim(
	merged: ReviewState,
	guide: Guide,
	parsed: DiffFile[],
	opts: { strict: boolean },
): string | undefined {
	const skim = resolveSkim(parsed, merged.changes, guide, opts)
	if (skim.ok) return undefined
	return skim.reason
}
