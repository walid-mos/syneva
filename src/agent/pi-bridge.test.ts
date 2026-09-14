import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localDeskUrl } from './desk-connection.js'
import { savedAttachment, wakeDeskOwner } from './pi-attachment.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

void test('every question or completed-review delivery requests a native wake of the owner', () => {
	const delivered: { message: unknown; options: unknown }[] = []
	const pi: Pick<ExtensionAPI, 'sendMessage'> = {
		sendMessage: (message, options) => {
			delivered.push({ message, options })
		},
	}
	const target = { repo: '/repo', session: 'review' }
	wakeDeskOwner(pi, target, '/events/question-one.json')
	wakeDeskOwner(pi, target, '/events/question-two.json')
	wakeDeskOwner(pi, target, '/events/review.json')
	assert.equal(delivered.length, 3)
	for (const delivery of delivered)
		assert.deepEqual(delivery.options, {
			triggerTurn: true,
			deliverAs: 'followUp',
		})
	assert.match(JSON.stringify(delivered[2].message), /\/events\/review.json/)
})

void test('reload restores the same owner but forks cannot inherit the parent listener', () => {
	const entries = [
		{
			type: 'custom',
			customType: 'galley-attachment',
			data: { owner: 'parent', target: { repo: '/repo', session: 's' } },
		},
	]
	assert.deepEqual(savedAttachment(entries, 'parent'), {
		repo: '/repo',
		session: 's',
	})
	assert.equal(savedAttachment(entries, 'child'), undefined)
})

void test('explicit detach prevents a later resume from resurrecting the listener', () => {
	const entries = [
		{
			type: 'custom',
			customType: 'galley-attachment',
			data: { owner: 'parent', target: { repo: '/repo', session: 's' } },
		},
		{
			type: 'custom',
			customType: 'galley-attachment',
			data: { owner: 'parent', target: undefined },
		},
	]
	assert.equal(savedAttachment(entries, 'parent'), undefined)
})

void test('attachments refuse non-loopback or credential-bearing desk URLs', () => {
	for (const url of [
		'https://example.com/',
		'http://example.com/',
		'http://127.0.0.1.example.com/',
		'http://user:pass@localhost/',
	])
		assert.throws(() => localDeskUrl(url), /loopback/)
	assert.equal(localDeskUrl('http://127.0.0.1:42000/').port, '42000')
})
