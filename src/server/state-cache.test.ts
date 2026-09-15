import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStateBodyCache } from './state-cache.js'

void test('reads during a yielding mutation never reuse or retain an intermediate body', async () => {
	const cache = createStateBodyCache()
	let phase = 'before'
	const render = (): string => phase
	assert.equal(cache.body('status', render), 'before')
	await cache.mutate(async () => {
		phase = 'first write'
		assert.equal(cache.body('status', render), 'first write')
		await Promise.resolve()
		phase = 'second write'
		assert.equal(cache.body('status', render), 'second write')
	})
	phase = 'committed'
	assert.equal(cache.body('status', render), 'committed')
})

void test('a failed mutation invalidates the body even after a partial write', async () => {
	const cache = createStateBodyCache()
	cache.body('status', () => 'before')
	await assert.rejects(
		cache.mutate(async () => {
			throw new Error('partial write')
		}),
		/partial write/,
	)
	assert.equal(
		cache.body('status', () => 'after failure'),
		'after failure',
	)
})

// The cache's whole contract is "run the render once per key", so every check below counts renders
// and hands back a different body per call: a reuse and a re-render can return the same text, and
// only the count plus the body returned tell them apart.
function countedRender(bodies: string[]): {
	render: () => string
	renders: () => number
} {
	let renders = 0
	return {
		render(): string {
			const body = bodies[Math.min(renders, bodies.length - 1)]
			renders += 1
			return body
		},
		renders: (): number => renders,
	}
}

void test('reuses the serialized body while the review revision holds', () => {
	const cache = createStateBodyCache()
	const render = countedRender(['{"comments":[]}'])
	const statusKey = '{"agentActivity":null}'

	cache.body(statusKey, render.render)
	const second = cache.body(statusKey, render.render)

	assert.equal(second, '{"comments":[]}')
	assert.equal(render.renders(), 1, 'the second read reused the cached body')
})

void test('re-renders once the review is invalidated', () => {
	const cache = createStateBodyCache()
	const render = countedRender(['{"comments":[]}', '{"comments":[1]}'])
	const statusKey = '{"agentActivity":null}'

	cache.body(statusKey, render.render)
	cache.invalidate()

	assert.equal(
		cache.body(statusKey, render.render),
		'{"comments":[1]}',
		'the invalidated body is rebuilt',
	)
	assert.equal(render.renders(), 2)
})

void test('a moved status key re-renders without a review mutation', () => {
	const cache = createStateBodyCache()
	const render = countedRender([
		'{"agentActivity":null}',
		'{"agentActivity":{"body":"Working…"}}',
	])

	// No invalidate() between the two reads: DeskStatus comes from the live process, not from the
	// review, so the review revision alone must not be treated as the whole key.
	cache.body('{"agentActivity":null}', render.render)

	assert.equal(
		cache.body('{"agentActivity":{"body":"Working…"}}', render.render),
		'{"agentActivity":{"body":"Working…"}}',
	)
	assert.equal(render.renders(), 2)
})
