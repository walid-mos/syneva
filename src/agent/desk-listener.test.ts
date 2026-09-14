import assert from 'node:assert/strict'
import { test } from 'node:test'

import { startDeskListener } from './desk-listener.js'

void test('one attachment delivers consecutive questions and a completed review, then keeps listening', async () => {
	const controller = new AbortController()
	const events = ['question one', 'question two', 'review']
	const received: string[] = []
	let calls = 0
	let rearmed = (): void => {}
	const listeningAgain = new Promise<void>(resolve => { rearmed = resolve })
	const listener = startDeskListener({
		signal: controller.signal,
		receive: async signal => {
			calls++
			const event = events.shift()
			if (event) return event
			rearmed()
			return new Promise<string>(resolve =>
				signal.addEventListener('abort', () => resolve(''), {
					once: true,
				}),
			)
		},
		deliver: event => {
			received.push(event)
		},
	})
	await listeningAgain
	assert.deepEqual(received, ['question one', 'question two', 'review'])
	assert.equal(calls, 4)
	controller.abort()
	await listener
})

void test('a long-poll timeout rearms without sending an empty agent message', async () => {
	const controller = new AbortController()
	const received: string[] = []
	let calls = 0
	await startDeskListener({
		signal: controller.signal,
		receive: async () => (++calls === 1 ? '' : 'review'),
		deliver: event => {
			received.push(event)
			controller.abort()
		},
	})
	assert.deepEqual(received, ['review'])
	assert.equal(calls, 2)
})

void test('shutdown cannot inject a late event into the replacement Pi session', async () => {
	const controller = new AbortController()
	const received: string[] = []
	await startDeskListener({
		signal: controller.signal,
		receive: async () => {
			controller.abort()
			return 'late question'
		},
		deliver: event => {
			received.push(event)
		},
	})
	assert.deepEqual(received, [])
})

void test('transport failures are observable, not silently treated as an empty event', async () => {
	await assert.rejects(
		startDeskListener({
			signal: new AbortController().signal,
			receive: async () => {
				throw new Error('desk disconnected')
			},
			deliver: () => assert.fail('must not deliver'),
		}),
		/desk disconnected/,
	)
})
