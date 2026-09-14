import { promises as fs } from 'node:fs'

import { indexHtmlPath, uiBundlePath } from '../assets.js'
import { HTTP_NO_CONTENT, HTTP_NOT_MODIFIED, HTTP_OK } from '../http.js'

import type { RouteRequest } from '../router.js'

export async function serveIndex({ res }: RouteRequest): Promise<void> {
	const file = await indexHtmlPath()
	res.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' })
	res.end(await fs.readFile(file, 'utf8'))
}

// The UI bundle is the desk's biggest asset and changes only on a rebuild, so it carries an
// etag derived from size+mtime: the tab revalidates cheaply and a 304 skips the body entirely.
export async function serveUiBundle({ req, res }: RouteRequest): Promise<void> {
	const file = await uiBundlePath()
	const stat = await fs.stat(file).catch(() => null)
	const etag = stat ? `"${stat.size}-${Math.round(stat.mtimeMs)}"` : ''
	if (etag && req.headers['if-none-match'] === etag) {
		res.writeHead(HTTP_NOT_MODIFIED)
		res.end()
		return
	}
	const js = await fs.readFile(file, 'utf8').catch(() => '')
	res.writeHead(HTTP_OK, {
		'content-type': 'text/javascript; charset=utf-8',
		...cacheHeaders(etag),
	})
	res.end(js)
}

function cacheHeaders(
	etag: string,
): { etag: string; 'cache-control': string } | undefined {
	if (!etag) return undefined
	return { etag, 'cache-control': 'no-cache' }
}

export async function serveFavicon({ res }: RouteRequest): Promise<void> {
	res.writeHead(HTTP_NO_CONTENT)
	res.end()
}
