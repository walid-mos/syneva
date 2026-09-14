import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sideFromLineType } from './selection-derive.js'

void test('a drag ending on a deletion row (unified view) tags the selection deletions', () => {
	// Stacked/unified view carries both sides in one column, so geometry can't tell the side -
	// @pierre's data-line-type on the row does. A deletion row → "deletions".
	assert.equal(sideFromLineType('deletion'), 'deletions')
	assert.equal(sideFromLineType('change-deletion'), 'deletions')
})

void test('an addition row tags the selection additions', () => {
	assert.equal(sideFromLineType('addition'), 'additions')
	assert.equal(sideFromLineType('change-addition'), 'additions')
})

void test('a context or unknown row yields null so the caller can fall back to geometry', () => {
	assert.equal(sideFromLineType('context'), null)
	assert.equal(sideFromLineType(''), null)
	assert.equal(sideFromLineType(null), null)
	assert.equal(sideFromLineType(undefined), null)
})
