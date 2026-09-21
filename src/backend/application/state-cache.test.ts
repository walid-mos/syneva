import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStateBodyCache } from './state-cache.js'

// The cache's whole contract is "run the render once per (revision, transient) key", so every check
// below counts renders and hands back a different body per call: a reuse and a re-render can return
// the same text, and only the count plus the body returned tell them apart.
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

void test('reuses the serialized body while the revision and transient key hold', () => {
	const cache = createStateBodyCache()
	const render = countedRender(['{"comments":[]}'])
	const statusKey = '{"agentActivity":null}'

	cache.body(1, statusKey, render.render)
	const second = cache.body(1, statusKey, render.render)

	assert.equal(second, '{"comments":[]}')
	assert.equal(render.renders(), 1, 'the second read reused the cached body')
})

void test('re-renders once the revision moves (a mutation committed a new state root)', () => {
	const cache = createStateBodyCache()
	const render = countedRender(['{"comments":[]}', '{"comments":[1]}'])
	const statusKey = '{"agentActivity":null}'

	cache.body(1, statusKey, render.render)

	assert.equal(
		cache.body(2, statusKey, render.render),
		'{"comments":[1]}',
		'the committed review is rebuilt',
	)
	assert.equal(render.renders(), 2)
})

void test('a moved status key re-renders without a revision bump', () => {
	const cache = createStateBodyCache()
	const render = countedRender([
		'{"agentActivity":null}',
		'{"agentActivity":{"body":"Working…"}}',
	])

	// Same revision twice: DeskStatus comes from the live process, not from the review, so the
	// application revision alone must not be treated as the whole key.
	cache.body(1, '{"agentActivity":null}', render.render)

	assert.equal(
		cache.body(1, '{"agentActivity":{"body":"Working…"}}', render.render),
		'{"agentActivity":{"body":"Working…"}}',
	)
	assert.equal(render.renders(), 2)
})
