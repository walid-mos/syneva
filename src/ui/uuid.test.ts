import assert from 'node:assert/strict'
import { test } from 'node:test'

import { uuid, uuidFallback } from './uuid'

// Standard v4 shape: 8-4-4-4-12 hex groups, version nibble "4", variant nibble in [89ab].
const V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

void test('uuidFallback returns v4-format ids', () => {
	assert.match(uuidFallback(), V4)
})

void test('uuidFallback: successive calls differ', () => {
	assert.notEqual(uuidFallback(), uuidFallback())
})

// The native function's declared return type: a v4 sentinel has to match it to stand in.
type RandomUuid = ReturnType<Crypto['randomUUID']>

// Swap crypto.randomUUID for the duration of one test, restoring the original descriptor after.
// defineProperty states "present but undefined" (an insecure context) without an assertion -
// the property is typed as always-callable.
function withRandomUuid(
	randomUuid: RandomUuid | undefined,
	run: () => void,
): void {
	const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
	Object.defineProperty(crypto, 'randomUUID', {
		value: randomUuid ? () => randomUuid : undefined,
		configurable: true,
	})
	try {
		run()
	} finally {
		if (original) Object.defineProperty(crypto, 'randomUUID', original)
	}
}

void test('uuid: falls back to v4 format when crypto.randomUUID is absent', () => {
	// An insecure context (plain-http origin): randomUUID is missing, getRandomValues is not.
	withRandomUuid(undefined, () => assert.match(uuid(), V4))
})

void test('uuid: uses the native implementation when available', () => {
	const sentinel: RandomUuid = '11111111-1111-4111-8111-111111111111'
	withRandomUuid(sentinel, () => assert.equal(uuid(), sentinel))
})
