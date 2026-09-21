import { promises as fs } from 'node:fs'

import { resolveContained } from '../../../../application/containment.js'
import { BAD_PATH } from '../failure.js'
import { HTTP_NOT_FOUND, HTTP_OK, fail } from '../http.js'

import type { ApiFailure } from '../failure.js'
import type { RouteRequest } from '../router.js'

// Image mime types by extension - /api/blob serves only repo-referenced images from the rendered
// markdown view. Everything else falls back to a generic binary type; the strict result is the
// containment check, not the mime map (the desk already serves any repo file's TEXT via /api/file).
const MIME_BY_EXTENSION: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
}

function mimeOf(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

// GET /api/blob?path=<repo-relative> - the raw bytes of one repo file, for the rendered
// markdown view's relative image srcs (<img src="assets/shot.png"> points here after the
// engine rewrites them). Same containment boundary as /api/file: repo-relative, no escapes.
export async function serveBlob({
	ctx,
	res,
	url,
}: RouteRequest): Promise<void> {
	const rel = url.searchParams.get('path') ?? ''
	const resolved = await resolveContained(
		ctx.state.root,
		rel,
		ctx.git.workspace,
	)
	if ('error' in resolved && resolved.error === 'escape')
		return fail(res, BAD_PATH)
	if (!('abs' in resolved)) return fail(res, cannotRead(rel))
	try {
		const bytes = await fs.readFile(resolved.abs)
		res.writeHead(HTTP_OK, { 'content-type': mimeOf(rel) })
		res.end(bytes)
	} catch {
		fail(res, cannotRead(rel))
	}
}

// A "cannot read" fallback, mirroring /api/file's failure shape.
function cannotRead(rel: string): ApiFailure {
	return {
		status: HTTP_NOT_FOUND,
		code: 'NOT_FOUND',
		error: `Cannot read "${rel}".`,
		fix: 'Check the path is a readable file in the repo.',
	}
}
