import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { resolveBinding } from './binding.js'

void test('resolveBinding: the loopback default widens nothing and keeps both URLs on 127.0.0.1', () => {
	for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
		const b = resolveBinding(host, 'devbox', ['exotic.example'])
		assert.equal(b.browserHost, '127.0.0.1', `${host} browserHost`)
		assert.equal(b.lockHost, '127.0.0.1', `${host} lockHost`)
		// The property to guard jealously: a loopback bind trusts ONLY the loopback authorities - the
		// machine hostname and SYNEVA_ALLOWED_HOSTS never leak in.
		assert.ok(
			isDeepStrictEqual(b.allowedHosts, [
				'127.0.0.1',
				'localhost',
				'[::1]',
			]),
			`${host} allowedHosts`,
		)
	}
})

void test('resolveBinding: a wildcard bind advertises the hostname but locks over loopback', () => {
	for (const host of ['0.0.0.0', '::', '[::]']) {
		const b = resolveBinding(host, 'devbox', ['dev.tail1234.ts.net'])
		assert.equal(
			b.browserHost,
			'devbox',
			`${host} browserHost is the hostname`,
		)
		assert.equal(
			b.lockHost,
			'127.0.0.1',
			`${host} lockHost stays loopback (still reachable)`,
		)
		// Loopback set + hostname + env hosts; no single bound address to add for a wildcard.
		assert.ok(
			isDeepStrictEqual(b.allowedHosts, [
				'127.0.0.1',
				'localhost',
				'[::1]',
				'devbox',
				'dev.tail1234.ts.net',
			]),
		)
	}
})

void test('resolveBinding: a specific non-loopback bind uses that address for both URLs and the guard', () => {
	const b = resolveBinding('100.64.1.5', 'devbox', [])
	// Loopback can't reach a socket bound only to a specific address, so the lock must use it too.
	assert.equal(b.browserHost, '100.64.1.5')
	assert.equal(b.lockHost, '100.64.1.5')
	assert.ok(
		isDeepStrictEqual(b.allowedHosts, [
			'127.0.0.1',
			'localhost',
			'[::1]',
			'devbox',
			'100.64.1.5',
		]),
	)
})

void test('resolveBinding: an IPv6 literal bind is bracket-wrapped for URLs and authorities', () => {
	const b = resolveBinding('fd7a:115c:a1e0::1', 'devbox', [
		'dev.tail1234.ts.net',
	])
	assert.equal(b.browserHost, '[fd7a:115c:a1e0::1]')
	assert.equal(b.lockHost, '[fd7a:115c:a1e0::1]')
	assert.ok(
		isDeepStrictEqual(b.allowedHosts, [
			'127.0.0.1',
			'localhost',
			'[::1]',
			'devbox',
			'[fd7a:115c:a1e0::1]',
			'dev.tail1234.ts.net',
		]),
	)
})
