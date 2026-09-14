import type { Guide, GuideFile } from './types.js'

export type GuideValidation =
	| { ok: true; guide: Guide }
	| { ok: false; reason: string }

type GuideBlock = NonNullable<GuideFile['skimBlocks']>[number]
type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

// A [start, end] span is exactly two numbers; anything else is rejected.
const SPAN_LENGTH = 2

const DEFAULT_CATEGORY = 'Changes'
const OVERVIEW_REASON = 'guide.overview must be a non-empty string'
const FILES_REASON = 'guide.files must be an array'
const SPAN_REASON = 'a line number or a [start, end] pair'

function fail(reason: string): { ok: false; reason: string } {
	return { ok: false, reason }
}

// Validate + normalize an agent-supplied guide. Required: a non-empty `overview` and a
// non-empty `files` array whose every entry has a `path` and an `orientation`. `order` and
// `category` are optional (default to the entry's position / "Changes"); `flag` is an
// optional note whose presence raises the file's flag. Returns the normalized guide with
// files sorted by `order`, or a reason the input was rejected. Pure - no IO - so it's the
// same check on the server and CLI.
export function validateGuide(input: unknown): GuideValidation {
	const parsed = parseGuide(input)
	if (!parsed.ok) return { ok: false, reason: parsed.reason }
	return { ok: true, guide: parsed.value }
}

function parseGuide(input: unknown): Parsed<Guide> {
	if (typeof input !== 'object' || input === null)
		return fail('guide must be an object')
	if (!('overview' in input)) return fail(OVERVIEW_REASON)
	const { overview } = input
	if (typeof overview !== 'string' || !overview.trim())
		return fail(OVERVIEW_REASON)
	if (!('files' in input)) return fail(FILES_REASON)
	const { files: rawFiles } = input
	if (!Array.isArray(rawFiles)) return fail(FILES_REASON)
	if (!rawFiles.length) return fail('guide.files must not be empty')
	const files = parseGuideFiles(rawFiles)
	if (!files.ok) return files
	const extras = parseGuideExtras(input)
	if (!extras.ok) return extras
	return {
		ok: true,
		value: {
			overview,
			files: files.value.toSorted((a, b) => a.order - b.order),
			...extras.value,
		},
	}
}

// Focused-review flag (issue 04) - display-only, badges the overview. A boolean or absent;
// any other type is a schema violation (consistent with the per-file shape checks).
function parseGuideExtras(input: object): Parsed<Partial<Guide>> {
	const extras: Partial<Guide> = {}
	if ('focused' in input && input.focused) {
		if (typeof input.focused !== 'boolean')
			return fail('guide.focused must be a boolean')
		extras.focused = input.focused
	}
	if (
		'title' in input &&
		typeof input.title === 'string' &&
		input.title.trim()
	)
		extras.title = input.title
	if (
		'prDescription' in input &&
		typeof input.prDescription === 'string' &&
		input.prDescription.trim()
	)
		extras.prDescription = input.prDescription
	if (
		'baseDiffHash' in input &&
		typeof input.baseDiffHash === 'string' &&
		input.baseDiffHash
	)
		extras.baseDiffHash = input.baseDiffHash
	return { ok: true, value: extras }
}

function parseGuideFiles(rawFiles: unknown[]): Parsed<GuideFile[]> {
	const files: GuideFile[] = []
	for (let index = 0; index < rawFiles.length; index++) {
		const file = parseGuideFile(rawFiles[index], index)
		if (!file.ok) return file
		files.push(file.value)
	}
	return { ok: true, value: files }
}

function parseGuideFile(raw: unknown, index: number): Parsed<GuideFile> {
	const where = `guide.files[${index}]`
	if (typeof raw !== 'object' || raw === null)
		return fail(`${where} must be an object`)
	const identity = parseFileIdentity(raw, where)
	if (!identity.ok) return identity
	const optional = parseFileOptionalFields(raw, where)
	if (!optional.ok) return optional
	return {
		ok: true,
		value: {
			...identity.value,
			order:
				'order' in raw &&
				typeof raw.order === 'number' &&
				Number.isFinite(raw.order)
					? raw.order
					: index,
			category:
				'category' in raw &&
				typeof raw.category === 'string' &&
				raw.category.trim()
					? raw.category
					: DEFAULT_CATEGORY,
			...optional.value,
		},
	}
}

function parseFileIdentity(
	raw: object,
	where: string,
): Parsed<{ path: string; orientation: string }> {
	if (!('path' in raw))
		return fail(`${where}.path must be a non-empty string`)
	const { path } = raw
	if (typeof path !== 'string' || !path.trim())
		return fail(`${where}.path must be a non-empty string`)
	if (!('orientation' in raw))
		return fail(`${where}.orientation must be a non-empty string`)
	const { orientation } = raw
	if (typeof orientation !== 'string' || !orientation.trim())
		return fail(`${where}.orientation must be a non-empty string`)
	return { ok: true, value: { path, orientation } }
}

function parseFileOptionalFields(
	raw: object,
	where: string,
): Parsed<Partial<GuideFile>> {
	const optional: Partial<GuideFile> = {}
	if ('flag' in raw && typeof raw.flag === 'string' && raw.flag.trim())
		optional.flag = raw.flag
	// Skim fields (focused review). File-level `skim`/`skimReason` collapse the whole file;
	// `skimBlocks` are new-side line spans. This is SHAPE validation only - whether a span
	// actually resolves to a change block is diff-aware and checked later (resolveSkim in
	// state/guide-resolve.ts), because validateGuide is pure (no diff in hand).
	if ('skim' in raw && raw.skim === true) optional.skim = true
	if (
		'skimReason' in raw &&
		typeof raw.skimReason === 'string' &&
		raw.skimReason.trim()
	)
		optional.skimReason = raw.skimReason
	const skimBlocks = parseSkimBlocksField(raw, where)
	if (!skimBlocks.ok) return skimBlocks
	if (skimBlocks.value) optional.skimBlocks = skimBlocks.value
	const movedFrom = parseMovedFromField(raw, where, optional.skimBlocks)
	if (!movedFrom.ok) return movedFrom
	if (movedFrom.value) optional.movedFrom = movedFrom.value
	return { ok: true, value: optional }
}

function parseSkimBlocksField(
	raw: object,
	where: string,
): Parsed<GuideBlock[] | undefined> {
	if (!('skimBlocks' in raw) || !raw.skimBlocks)
		return { ok: true, value: undefined }
	if (!Array.isArray(raw.skimBlocks))
		return fail(`${where}.skimBlocks must be an array`)
	const blocks = parseSkimBlocks(raw.skimBlocks, where)
	if (!blocks.ok) return blocks
	return { ok: true, value: blocks.value.length ? blocks.value : undefined }
}

function parseSkimBlocks(
	rawBlocks: unknown[],
	where: string,
): Parsed<GuideBlock[]> {
	const blocks: GuideBlock[] = []
	for (let index = 0; index < rawBlocks.length; index++) {
		const block = parseSkimBlock(
			rawBlocks[index],
			`${where}.skimBlocks[${index}]`,
		)
		if (!block.ok) return block
		blocks.push(block.value)
	}
	return { ok: true, value: blocks }
}

function parseSkimBlock(raw: unknown, where: string): Parsed<GuideBlock> {
	if (typeof raw !== 'object' || raw === null)
		return fail(`${where} must be an object`)
	const lines = parseSkimLines('lines' in raw ? raw.lines : undefined)
	if (!lines.ok) return fail(`${where}.lines must be ${SPAN_REASON}`)
	const block: GuideBlock = { lines: lines.value }
	if ('reason' in raw && typeof raw.reason === 'string' && raw.reason.trim())
		block.reason = raw.reason
	return { ok: true, value: block }
}

// `lines` is a [start, end] span or a bare number (a single line, normalized to [n, n]).
function parseSkimLines(raw: unknown): Parsed<[number, number]> {
	if (typeof raw === 'number' && Number.isFinite(raw))
		return { ok: true, value: [raw, raw] }
	if (!Array.isArray(raw) || raw.length !== SPAN_LENGTH)
		return fail(SPAN_REASON)
	const [start, end] = raw
	if (
		typeof start !== 'number' ||
		typeof end !== 'number' ||
		!Number.isFinite(start) ||
		!Number.isFinite(end)
	)
		return fail(SPAN_REASON)
	return { ok: true, value: start <= end ? [start, end] : [end, start] }
}

// Guide-declared move (issue 03): `movedFrom` is the OLD path a moved+edited file came from.
// Shape-only here (non-empty string) - whether it resolves to a full deletion + untracked
// addition is diff-aware (resolveMovedFrom in state/guide-resolve.ts). Rejecting movedFrom+skimBlocks on one
// entry is a real check, not shape: the merge collapses the pair into one section with no
// rawDiff, so a skimBlocks span (which resolves against rawDiff) could never match. Whole-file
// `skim` stays allowed (a client-side flag needing no resolution).
function parseMovedFromField(
	raw: object,
	where: string,
	skimBlocks: GuideBlock[] | undefined,
): Parsed<string | undefined> {
	if (!('movedFrom' in raw) || !raw.movedFrom)
		return { ok: true, value: undefined }
	if (typeof raw.movedFrom !== 'string' || !raw.movedFrom.trim())
		return fail(`${where}.movedFrom must be a non-empty string`)
	if (skimBlocks?.length)
		return fail(`${where} cannot set both movedFrom and skimBlocks`)
	return { ok: true, value: raw.movedFrom }
}
