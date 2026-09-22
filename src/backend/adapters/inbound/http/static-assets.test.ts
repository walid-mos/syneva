import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { serveUiChunk } from './routes/static.js'

void test('deferred JS chunks are served and revalidated; missing and unsafe names are rejected', async () => {
	const name = `test-${randomBytes(4).toString('hex').toUpperCase()}.js`
	const file = `dist/chunks/${name}`
	await mkdir('dist/chunks', { recursive: true })
	await writeFile(file, 'export const chunkLoaded = true;')
	const server = createServer((req, res) => {
		void serveUiChunk({
			req,
			res,
			url: new URL(req.url ?? '/', 'http://localhost'),
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	assert.ok(address && typeof address !== 'string')
	const root = `http://127.0.0.1:${address.port}/chunks/`
	try {
		const response = await fetch(root + name)
		assert.equal(response.status, 200)
		assert.match(response.headers.get('content-type') ?? '', /javascript/)
		assert.equal(await response.text(), 'export const chunkLoaded = true;')
		const etag = response.headers.get('etag')
		assert.ok(etag)
		const cached = await fetch(root + name, {
			headers: { 'if-none-match': etag },
		})
		assert.equal(cached.status, 304)
		assert.equal(await cached.text(), '')
		const rejected = await Promise.all(
			[
				'missing-00000000.js',
				'secret.json',
				'%2e%2e%2fpackage.json',
				'nested/chunk-ABCDEFGH.js',
			].map(async suffix => (await fetch(root + suffix)).status),
		)
		assert.ok(isDeepStrictEqual(rejected, [404, 404, 404, 404]))
	} finally {
		server.closeAllConnections()
		await new Promise<void>((resolve, reject) =>
			server.close(error => (error ? reject(error) : resolve())),
		)
		await rm(file)
	}
})
