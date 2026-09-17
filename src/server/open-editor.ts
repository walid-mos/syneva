import path from 'node:path'

import { normalizeLine, resolveEditorCommand } from '../editor.js'
import { readGlobalSettings } from '../state/desk.js'

import { errorMessage } from './failure.js'

import type { EditorCommand } from '../editor.js'

export type OpenEditorRequest = { path: string; lineNumber: number }

// The reviewer's file-open request, decoded at the boundary: a body without a usable path is the
// caller's error (the route answers 400), an absent line means the top of the file.
export function parseOpenEditorRequest(payload: unknown): OpenEditorRequest {
	if (typeof payload !== 'object' || payload === null)
		return { path: '', lineNumber: normalizeLine(undefined) }
	const rel =
		'path' in payload && typeof payload.path === 'string'
			? payload.path
			: ''
	const line = 'lineNumber' in payload ? payload.lineNumber : undefined
	return { path: rel, lineNumber: normalizeLine(line) }
}

export type EditorTarget =
	| { ok: true; command: EditorCommand }
	| { ok: false; code: string; message: string }

// The editor command is a reviewer/machine preference, so it lives in the global
// ~/.syneva/settings.json with the rest of them (deliberately not per-repo). A template the
// allowlist refuses is the caller's to fix - hence the code the route turns into a 422.
export async function resolveEditorTarget(
	root: string,
	file: string,
	line: number,
): Promise<EditorTarget> {
	const settings = await readGlobalSettings()
	try {
		const command = resolveEditorCommand(editorTemplate(settings), {
			repo: path.resolve(root),
			file,
			line,
		})
		return { ok: true, command }
	} catch (error) {
		const message = errorMessage(error)
		return {
			ok: false,
			code: message.includes('not allowed')
				? 'EDITOR_NOT_ALLOWED'
				: 'BAD_EDITOR_COMMAND',
			message,
		}
	}
}

// Only an absent preference falls back to the OS opener. Malformed configured values must
// fail instead of silently selecting an application the reviewer did not request.
function editorTemplate(settings: Record<string, unknown>): string {
	const nested = settings.settings
	if (
		typeof nested !== 'object' ||
		nested === null ||
		!('editorCommand' in nested)
	)
		return ''
	const template = nested.editorCommand ?? ''
	if (typeof template === 'string') return template
	if (typeof template === 'number' || typeof template === 'boolean')
		return String(template)
	throw new Error(
		`Editor command type ${typeof template} is not allowed; set settings.editorCommand to a command string.`,
	)
}
