import { DOCS } from './failure.js'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiFailure } from './failure.js'

// The desk's HTTP status vocabulary. Named so every route spells the same code the same
// way - the response codes are part of the agent contract (`galley spec`), not decoration.
export const HTTP_OK = 200
export const HTTP_NO_CONTENT = 204
export const HTTP_NOT_MODIFIED = 304
export const HTTP_BAD_REQUEST = 400
export const HTTP_FORBIDDEN = 403
export const HTTP_NOT_FOUND = 404
export const HTTP_CONFLICT = 409
export const HTTP_UNPROCESSABLE = 422
export const HTTP_INTERNAL = 500

// 50 MB: pre-0.6.2 tabs post the entire multi-MB ReviewState on /api/send, and a big PR desk
// crosses 5 MB - the old cap made Send fail on exactly the largest reviews (readBody threw
// before the result was built, so no artifact and no event, while slice-only auto-saves kept
// succeeding). The server is localhost-only, so a generous cap is safe.
const MAX_BODY_BYTES = 50_000_000

export async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
		size += buf.length
		if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
		chunks.push(buf)
	}
	return Buffer.concat(chunks).toString('utf8')
}

export function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(body))
}

export function fail(res: ServerResponse, failure: ApiFailure): void {
	json(res, failure.status, {
		error: failure.error,
		code: failure.code,
		fix: failure.fix,
		docs: DOCS,
	})
}
