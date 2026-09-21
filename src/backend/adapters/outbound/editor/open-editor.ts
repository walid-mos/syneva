import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { errorMessage } from '../../../application/errors.js'
import { readGlobalSettings } from '../filesystem/desk.js'

import { resolveEditorCommand } from './editor.js'

import type { EditorLaunch, EditorPort } from '../../../application/ports.js'
import type { EditorCommand } from './editor.js'

// An editor that has not attached within five seconds is hung (no TTY - see editor.ts); the desk
// must answer the tab either way.
const EDITOR_TIMEOUT_MS = 5000

const execFileAsync = promisify(execFile)

// The editor adapter's implementation of the application's editor capability: resolve the
// reviewer's command template from the global settings, then launch it. A preference the
// allowlist refuses and a failed spawn are both reported as EditorLaunch failures - the
// route turns the codes into 422 (preference) / 500 (launch) answers. `run` is the desk's
// launch seam (tests inject it); absent it is a real, bounded spawn (no TTY - see editor.ts).
export function editorPort(
	run?: (command: string, args: string[]) => Promise<void>,
): EditorPort {
	return Object.freeze({
		// Parameters annotated explicitly: Object.freeze drops the port's contextual typing, so
		// the arrow would otherwise infer implicit anys.
		open: async (
			root: string,
			file: string,
			line: unknown,
		): Promise<EditorLaunch> => {
			const target = await resolveEditorTarget(root, file, line)
			if (!target.ok) return target
			try {
				if (run) await run(target.command.command, target.command.args)
				else
					await execFileAsync(
						target.command.command,
						target.command.args,
						{ timeout: EDITOR_TIMEOUT_MS },
					)
				return { ok: true }
			} catch (error) {
				return {
					ok: false,
					code: 'EDITOR_FAILED',
					message: errorMessage(error),
				}
			}
		},
	})
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
	line: unknown,
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
