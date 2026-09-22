import type { Guide, GuideFile } from './review.js'

export type GuideValidation =
	| { ok: true; guide: Guide }
	| { ok: false; reason: string }

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

const DEFAULT_CATEGORY = 'Changes'
const FILES_REASON =
	'guide.files must be a non-empty array of { path, category?, order? }'

function fail(reason: string): { ok: false; reason: string } {
	return { ok: false, reason }
}

// Validate + normalize an agent-supplied grouping guide. Required: a non-empty `files` array whose
// every entry carries a `path`. `order` and `category` are optional (defaults: the entry's array
// position / "Changes"). Every other key is ignored, so a guide written against the older
// guided-review schema (orientation, flag, skim, movedFrom, overview, …) still attaches and simply
// groups. Pure - no IO - so it's the same check on the server and CLI.
export function validateGuide(input: unknown): GuideValidation {
	const parsed = parseGuide(input)
	if (!parsed.ok) return { ok: false, reason: parsed.reason }
	return { ok: true, guide: parsed.value }
}

function parseGuide(input: unknown): Parsed<Guide> {
	if (typeof input !== 'object' || input === null)
		return fail('guide must be an object')
	if (!('files' in input) || !Array.isArray(input.files))
		return fail(FILES_REASON)
	if (!input.files.length) return fail(FILES_REASON)
	const files = parseGuideFiles(input.files)
	if (!files.ok) return files
	const extras = parseGuideExtras(input)
	if (!extras.ok) return extras
	return {
		ok: true,
		value: {
			files: files.value.toSorted((a, b) => a.order - b.order),
			...extras.value,
		},
	}
}

// Only the fields the desk still reads. `baseDiffHash` is stamped by the desk on attach; a value
// already in the file (a round-tripped guide) is honored so it isn't silently refreshed.
function parseGuideExtras(input: object): Parsed<Partial<Guide>> {
	// Guide is immutable domain data, so the optional stamp is built as a literal
	// instead of mutating a Partial record field by field.
	if (
		'baseDiffHash' in input &&
		typeof input.baseDiffHash === 'string' &&
		input.baseDiffHash.trim()
	)
		return { ok: true, value: { baseDiffHash: input.baseDiffHash } }
	return { ok: true, value: {} }
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
	if (!('path' in raw) || typeof raw.path !== 'string' || !raw.path.trim())
		return fail(`${where}.path must be a non-empty string`)
	return {
		ok: true,
		value: {
			path: raw.path,
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
		},
	}
}
