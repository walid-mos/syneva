import { repoPath } from '../../../../application/containment.js'
import { BAD_PATH } from '../failure.js'
import {
	HTTP_INTERNAL,
	HTTP_OK,
	HTTP_UNPROCESSABLE,
	readJsonBody,
	json,
	fail,
} from '../http.js'

import type { RouteRequest } from '../router.js'

// The reviewer's file-open request, decoded at the transport boundary: a body without a
// usable path is the caller's error (the route answers 400); the line value is passed raw -
// the editor capability normalizes it (absent/non-integer → top of file).
function parseOpenEditorRequest(
	payload: unknown,
): { path: string; line: unknown } | null {
	if (typeof payload !== 'object' || payload === null) return null
	const filePath =
		'path' in payload && typeof payload.path === 'string'
			? payload.path
			: ''
	if (!filePath) return null
	return {
		path: filePath,
		line: 'lineNumber' in payload ? payload.lineNumber : undefined,
	}
}

export async function openInEditor({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	const body: unknown = await readJsonBody(req)
	const request = parseOpenEditorRequest(body)
	if (!request) return fail(res, BAD_PATH)
	const abs = repoPath(ctx.state.root, request.path)
	if (!abs) return fail(res, BAD_PATH)
	const launched = await ctx.editor.open(ctx.state.root, abs, request.line)
	if (!launched.ok)
		return fail(res, {
			// A preference the reviewer must fix answers 422; a failed launch is the desk's error.
			status:
				launched.code === 'EDITOR_FAILED'
					? HTTP_INTERNAL
					: HTTP_UNPROCESSABLE,
			code: launched.code,
			error: launched.message,
			fix:
				launched.code === 'EDITOR_FAILED'
					? 'Check the editor command in Settings and try again.'
					: 'Update the editor command in Settings.',
		})
	json(res, HTTP_OK, { ok: true })
}
