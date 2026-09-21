import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	CURATED_LANGS,
	loadCuratedGrammars,
} from '@shared/highlighting/shiki-langs'

// The curated set keys @pierre/diffs' file-name → language lookup (shiki-shim.ts) from STATIC
// metadata, while each grammar body loads lazily. A drifted name or alias would silently degrade
// that language to the shim's plain-text fallback instead of failing, so pin the metadata to what
// each grammar actually declares.
void test('every curated language declares the name and aliases of the grammar it loads', async () => {
	const loaded = await Promise.all(
		CURATED_LANGS.map(async language => (await language.load()).default),
	)
	CURATED_LANGS.forEach((language, index) => {
		const primary = loaded[index]?.at(-1)
		assert.equal(
			primary?.name,
			language.name,
			`${language.name}: grammar declares a different name`,
		)
		// The name assertion above leaves `primary` non-undefined, and the alias comparison goes in as
		// the unknown value a deep comparison takes (`assert.deepEqual` is an assertion function, so two
		// sides of one type leave its predicate nothing to narrow).
		const aliases: unknown = [...(primary.aliases ?? [])].toSorted()
		assert.deepEqual(
			aliases,
			[...(language.aliases ?? [])].toSorted(),
			`${language.name}: alias drift`,
		)
	})
})

void test('curated language keys never collide across names and aliases', () => {
	// Collisions matter: the shim registers one loader per key, so two entries claiming the same
	// key would let load order decide which grammar a file name resolves to.
	const keys = CURATED_LANGS.flatMap(language => [
		language.name,
		...(language.aliases ?? []),
	])
	const distinct: unknown = new Set(keys).size
	assert.equal(distinct, keys.length)
})

void test('loadCuratedGrammars resolves the markdown engine set in one pass', async () => {
	const grammars = await loadCuratedGrammars()
	const resolved: unknown = grammars.length
	assert.equal(resolved, CURATED_LANGS.length)
	for (const grammar of grammars)
		assert.ok(Array.isArray(grammar) && grammar.length > 0)
})
