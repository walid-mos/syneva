import path from 'node:path'

import { platformOpenCommand } from '../../platform-open.js'

// GUI editors + OS openers only. Terminal editors (vim/nvim/vi) are deliberately absent:
// the desk spawns the command from a server process with no TTY, so they could never
// attach - they'd hang until the exec timeout killed them.
const ALLOWED_EDITORS = new Set([
	'code',
	'cursor',
	'windsurf',
	'zed',
	'subl',
	'open',
	'xdg-open',
])

const SHELL_META = /[|&;<>`]/

export type EditorCommand = {
	command: string
	args: string[]
}

function editorName(command: string): string {
	const posix = path.basename(command)
	const win = path.win32.basename(command)
	return win.length < posix.length ? win : posix
}

function parseCommandTemplate(input: string): string[] {
	const tokens: string[] = []
	let current = ''
	let quote: "'" | '"' | null = null
	for (const ch of input) {
		const isQuote = ch === "'" || ch === '"'
		if (isQuote && (quote === null || quote === ch)) {
			quote = quote === null ? ch : null
			continue
		}
		if (quote !== null || !/\s/.test(ch)) {
			current += ch
			continue
		}
		if (current) {
			tokens.push(current)
			current = ''
		}
	}
	if (quote) throw new Error('Unclosed quote in editor command.')
	if (current) tokens.push(current)
	return tokens
}

function expandToken(
	token: string,
	values: { repo: string; file: string; line: number },
): string {
	return token
		.replaceAll('{repo}', values.repo)
		.replaceAll('{file}', values.file)
		.replaceAll('{line}', String(values.line))
}

export function normalizeLine(line: unknown): number {
	const n = typeof line === 'number' ? line : Number(line)
	return Number.isInteger(n) && n > 0 ? n : 1
}

export function resolveEditorCommand(
	template: string,
	values: { repo: string; file: string; line?: unknown },
): EditorCommand {
	const line = normalizeLine(values.line)
	const trimmed = template.trim()
	if (!trimmed) return platformOpenCommand(values.file)
	if (trimmed.includes('$(') || SHELL_META.test(trimmed))
		throw new Error('Editor command contains shell syntax.')
	const [commandTemplate, ...argumentTemplates] =
		parseCommandTemplate(trimmed)
	if (!commandTemplate) throw new Error('Editor command is empty.')
	const command = expandToken(commandTemplate, { ...values, line })
	const basename = editorName(command)
	if (!ALLOWED_EDITORS.has(basename))
		throw new Error(`Editor "${basename}" is not allowed.`)
	return {
		command,
		args: argumentTemplates.map(token =>
			expandToken(token, { ...values, line }),
		),
	}
}
