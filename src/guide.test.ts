import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { validateGuide } from './guide.js'
import { mergeReviewState } from './state/reconcile.js'

import type { Guide, ReviewState } from './types.js'

// A guide in the current shape: files carrying an optional category/order, nothing else.
const guideInput = (): unknown => ({
	files: [
		{ path: 'src/limiter.ts', order: 2, category: 'Core' },
		{ path: 'src/consts.ts', order: 1, category: 'Config' },
		{ path: 'README.md', order: 3 },
	],
})

// The normalized guide, or a loud failure - validateGuide's union doesn't narrow through assert.
function okGuide(input: unknown): Guide {
	const validation = validateGuide(input)
	if (!validation.ok)
		throw new Error(`expected a valid guide: ${validation.reason}`)
	return validation.guide
}

// Whether validateGuide accepts the input - the boolean face of its result union.
function isValid(input: unknown): boolean {
	return validateGuide(input).ok
}

// The rejection reason, or a loud failure when the input was accepted instead.
function rejectionReason(input: unknown): string {
	const validation = validateGuide(input)
	if (validation.ok)
		throw new Error('expected validateGuide to reject this input')
	return validation.reason
}

void test('validateGuide defaults order to the array position and category to "Changes"', () => {
	const { files } = okGuide({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] })
	assert.ok(
		isDeepStrictEqual(
			files.map(f => [f.order, f.category]),
			[
				[0, 'Changes'],
				[1, 'Changes'],
			],
		),
	)
})

void test('validateGuide keeps the path verbatim', () => {
	// Only trim()-truthiness is validated: the path is what the desk matches a diff file against.
	assert.equal(
		okGuide({ files: [{ path: ' spaced/name.ts ' }] }).files[0].path,
		' spaced/name.ts ',
	)
})

void test('validateGuide sorts files by order, ties keeping the input order', () => {
	assert.ok(
		isDeepStrictEqual(
			okGuide(guideInput()).files.map(f => f.path),
			['src/consts.ts', 'src/limiter.ts', 'README.md'],
		),
	)
	// Stable: a.ts (explicit 1) before c.ts (explicit 1), despite b.ts sitting between them.
	const ties = okGuide({
		files: [
			{ path: 'a.ts', order: 1 },
			{ path: 'b.ts', order: 0 },
			{ path: 'c.ts', order: 1 },
		],
	})
	assert.ok(
		isDeepStrictEqual(
			ties.files.map(f => f.path),
			['b.ts', 'a.ts', 'c.ts'],
		),
	)
})

void test('validateGuide ignores the retired guided-review keys', () => {
	// The desk only groups now: a guide written against the old schema (overview, orientation,
	// flag, skimBlocks, focused, movedFrom, …) must still attach rather than error out. Deep
	// equality proves nothing beyond the read fields survived normalization.
	const guide = okGuide({
		title: 'Add API rate limiting',
		overview: 'Adds rate limiting.',
		prDescription: 'Closes #312.',
		focused: true,
		baseDiffHash: 'abc',
		files: [
			{
				path: 'src/limiter.ts',
				order: 0,
				category: 'Core',
				orientation: 'The limiter.',
				flag: 'reject path',
				skim: true,
				skimReason: 'generated',
				skimBlocks: [{ lines: [1, 2], reason: 'imports' }],
				movedFrom: 'src/old.ts',
			},
		],
	})
	assert.deepEqual(guide, {
		baseDiffHash: 'abc',
		files: [{ path: 'src/limiter.ts', order: 0, category: 'Core' }],
	})
})

void test('validateGuide rejects malformed input', () => {
	const cases: unknown[] = [
		undefined,
		null,
		'nope',
		[],
		{},
		{ files: 'no' },
		{ files: [] },
		{ files: [{}] },
		{ files: [{ path: '' }] },
		{ files: [{ path: '   ' }] },
		{ files: [{ path: 42 }] },
		{ files: ['src/a.ts'] },
		{ files: [null] },
	]
	for (const [i, malformed] of cases.entries())
		assert.equal(isValid(malformed), false, `case ${i}`)
})

void test('validateGuide names the offending entry', () => {
	assert.match(
		rejectionReason({ files: [{ path: 'a.ts' }, {}] }),
		/guide\.files\[1\]\.path/,
	)
})

// Every baseDiffHash value worth trying, in the shape a guide carries it.
function withBaseDiffHash(baseDiffHash: unknown): unknown {
	return { files: [{ path: 'a.ts' }], baseDiffHash }
}

void test('validateGuide honors a non-empty baseDiffHash and drops any other value', () => {
	assert.equal(okGuide(withBaseDiffHash('abc')).baseDiffHash, 'abc')
	const others: unknown[] = [undefined, '', '   ', 0, null, 42, {}]
	for (const [i, baseDiffHash] of others.entries())
		assert.equal(
			okGuide(withBaseDiffHash(baseDiffHash)).baseDiffHash,
			undefined,
			`case ${i}`,
		)
})

// minimal state factory (mirrors state.test.ts)
function state(over: Partial<ReviewState>): ReviewState {
	return {
		id: 'id',
		session: 's',
		root: '/r',
		repoHash: 'h',
		mode: 'repo',
		staged: false,
		head: null,
		baseDiffHash: 'base',
		createdAt: 't',
		rawDiff: '',
		files: [],
		comments: [],
		changes: [],
		reviewedFiles: [],
		stagedFiles: [],
		...over,
	}
}

void test('mergeReviewState carries an attached guide across a reload', async () => {
	const guide: Guide = {
		files: [{ path: 'a.ts', order: 0, category: 'Config' }],
	}
	const base = state({ baseDiffHash: 'new' }) // freshly rebuilt diff - no guide
	const saved = state({ guide }) // live state with the attached guide
	const merged = await mergeReviewState(base, saved)
	assert.deepEqual(merged.guide, guide)
	assert.equal(merged.baseDiffHash, 'new')
})

void test('mergeReviewState leaves guide undefined when none was attached', async () => {
	const merged = await mergeReviewState(state({}), state({}))
	assert.equal(merged.guide, undefined)
})
