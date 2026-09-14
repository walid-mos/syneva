import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isGuideBaseStale } from './guide-derive.js'

void test('matching baseDiffHash is not stale', () => {
	assert.equal(isGuideBaseStale('h1', 'h1'), false)
})

void test('a differing baseDiffHash is stale', () => {
	assert.equal(isGuideBaseStale('h2', 'h1'), true)
})

void test('a guide with no baseDiffHash is never stale', () => {
	assert.equal(isGuideBaseStale('h1', undefined), false)
})
