import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickCurrentFile } from './current-file.js'

// A stand-in for the review's file records: the boundary only indexes and reorders, so the element
// type is irrelevant to it - which is exactly what these tests pin.
const FILES = ['alpha.ts', 'beta.ts']

await test('delayed initial state: no review yet means no current file', () => {
	// The pre-init window: main.ts has not adopted the first fetch, so there are no files to index.
	assert.ok(Object.is(pickCurrentFile(undefined, null, 0), null))
})

await test('ready review: the indexed file is the current one', () => {
	assert.equal(pickCurrentFile(FILES, null, 1), 'beta.ts')
})

await test('a preview wins over the indexed review file', () => {
	// Previews are UI-only: an unchanged file the reviewer opened reads as the current file even
	// while the review is still parked on another one.
	assert.equal(pickCurrentFile(FILES, 'notes.md', 0), 'notes.md')
})

await test('an emptied review (a reload that removed every file) has no current file', () => {
	assert.ok(Object.is(pickCurrentFile([], null, 0), null))
})

await test('an out-of-range index has no current file', () => {
	assert.equal(pickCurrentFile(FILES, null, 5), null)
})
