import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { CONTENT_READ_LIMIT, mapContentReads } from './content-reads.js'

const FILE_COUNT = 23
const paths = Array.from(
	{ length: FILE_COUNT },
	(_, index) => `file-${index}.ts`,
)

// A read that resolves on a later turn, so a second read can overlap with it.
const settleOn = async <Content>(content: Content): Promise<Content> => {
	await Promise.resolve()
	return content
}

const readContents = async (path: string): Promise<string> =>
	await settleOn(`contents of ${path}`)

void test('mapContentReads returns every result in the input order', async () => {
	const contents = await mapContentReads(paths, readContents)
	assert.ok(
		isDeepStrictEqual(
			contents,
			paths.map(path => `contents of ${path}`),
		),
	)
})

void test('mapContentReads keeps at most CONTENT_READ_LIMIT reads in flight', async () => {
	let inFlight = 0
	let peakInFlight = 0
	await mapContentReads(paths, async path => {
		inFlight++
		peakInFlight = Math.max(peakInFlight, inFlight)
		const contents = await readContents(path)
		inFlight--
		return contents
	})
	// Both bounds matter: never more than the limit (the resource guard), and never fewer while work
	// is left (the reads must still overlap rather than serialize).
	assert.equal(peakInFlight, CONTENT_READ_LIMIT)
})

void test('mapContentReads reads nothing for an empty list', async () => {
	let readCount = 0
	const contents = await mapContentReads([], async path => {
		readCount++
		return await readContents(path)
	})
	assert.deepEqual(contents, [])
	assert.equal(readCount, 0)
})

void test('mapContentReads rejects with the first read failure', async () => {
	const batch = ['a.ts', 'b.ts', 'c.ts']
	await assert.rejects(
		mapContentReads(batch, async path => {
			if (path === 'b.ts') throw new Error(`read ${path} failed`)
			return await readContents(path)
		}),
		/read b\.ts failed/,
	)
})
