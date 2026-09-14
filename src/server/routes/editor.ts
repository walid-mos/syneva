import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { repoPath } from '../containment.js'
import { BAD_PATH, errorMessage } from '../failure.js'
import {
	HTTP_INTERNAL,
	HTTP_OK,
	HTTP_UNPROCESSABLE,
	readBody,
	json,
	fail,
} from '../http.js'
import { parseOpenEditorRequest, resolveEditorTarget } from '../open-editor.js'

import type { EditorCommand } from '../../editor.js'
import type { RouteRequest } from '../router.js'

const execFileAsync = promisify(execFile)
// An editor that has not attached within five seconds is hung (no TTY - see editor.ts); the desk
// must answer the tab either way.
const EDITOR_TIMEOUT_MS = 5000

export async function openInEditor({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	const body: unknown = JSON.parse(await readBody(req))
	const request = parseOpenEditorRequest(body)
	const abs = repoPath(ctx.state.root, request.path)
	if (!request.path || !abs) return fail(res, BAD_PATH)
	const target = await resolveEditorTarget(
		ctx.state.root,
		abs,
		request.lineNumber,
	)
	if (!target.ok)
		return fail(res, {
			status: HTTP_UNPROCESSABLE,
			code: target.code,
			error: target.message,
			fix: 'Update the editor command in Settings.',
		})
	try {
		await runEditor(ctx.options.runEditorCommand, target.command)
	} catch (error) {
		return fail(res, {
			status: HTTP_INTERNAL,
			code: 'EDITOR_FAILED',
			error: errorMessage(error),
			fix: 'Check the editor command in Settings and try again.',
		})
	}
	json(res, HTTP_OK, { ok: true })
}

async function runEditor(
	seam: ((command: string, args: string[]) => Promise<void>) | undefined,
	command: EditorCommand,
): Promise<void> {
	if (seam) return await seam(command.command, command.args)
	await execFileAsync(command.command, command.args, {
		timeout: EDITOR_TIMEOUT_MS,
	})
}
