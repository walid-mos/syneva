import { promises as fs } from 'node:fs'

import {
	indexHtmlPath,
	uiBundlePath,
	uiChunkPath,
	workerBundlePath,
} from '../assets.js'
import {
	HTTP_NO_CONTENT,
	HTTP_NOT_FOUND,
	HTTP_NOT_MODIFIED,
	HTTP_OK,
} from '../http.js'

import type { RouteRequest } from '../router.js'

export async function serveIndex({ res }: RouteRequest): Promise<void> {
	const file = await indexHtmlPath()
	res.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' })
	res.end(await fs.readFile(file, 'utf8'))
}

// An etag'd JS asset server (ui.js, worker.js). Assets change only on a rebuild, so they carry an
// etag derived from size+mtime: the tab revalidates cheaply and a 304 skips the body entirely.
async function serveJsBundle(
	pathOf: () => Promise<string>,
	{ req, res }: Pick<RouteRequest, 'req' | 'res'>,
): Promise<void> {
	const file = await pathOf()
	const stat = await fs.stat(file).catch(() => null)
	if (!stat?.isFile()) {
		res.writeHead(HTTP_NOT_FOUND)
		res.end()
		return
	}
	const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`
	if (etag && req.headers['if-none-match'] === etag) {
		res.writeHead(HTTP_NOT_MODIFIED)
		res.end()
		return
	}
	const js = await fs.readFile(file, 'utf8').catch(() => undefined)
	if (!js) {
		res.writeHead(HTTP_NOT_FOUND)
		res.end()
		return
	}
	res.writeHead(HTTP_OK, {
		'content-type': 'text/javascript; charset=utf-8',
		...cacheHeaders(etag),
	})
	res.end(js)
}

export async function serveUiBundle(request: RouteRequest): Promise<void> {
	return serveJsBundle(uiBundlePath, request)
}

export async function serveUiChunk(
	request: Pick<RouteRequest, 'req' | 'res' | 'url'>,
): Promise<void> {
	const name = request.url.pathname.slice('/chunks/'.length)
	if (!/^[\w-]+-[A-Z0-9]{8}\.js$/.test(name)) {
		request.res.writeHead(HTTP_NOT_FOUND)
		request.res.end()
		return
	}
	return serveJsBundle(() => uiChunkPath(name), request)
}

export async function serveWorkerBundle(request: RouteRequest): Promise<void> {
	return serveJsBundle(workerBundlePath, request)
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
