import { spawn } from 'node:child_process'
import path from 'node:path'

import type { ChildProcess } from 'node:child_process'
import type { DeskConnection } from './desk-connection.js'

/** Answer size cap: prose, but a runaway reply must not reach the parser unbounded. */
const MAX_REPLY_CHARS = 100_000

const CORRESPONDENT_TIMEOUT_MS = 240_000
const CORRESPONDENT_MAX_OUTPUT_BYTES = 16_777_216
const STDERR_IN_ERROR_CHARS = 300

type ThreadStreams = { stdout: string; stderr: string }
// One thread per desk session: the session FILE is the agent. Each answer materializes it
// with `pi -p` in the repo cwd and resumes that conversation - warm context across
// questions (and desk restarts) without ever turning the owning session into a router,
// and without per-answer children. This is the deterministic parallel agent.
export function correspondentSessionFile(connection: DeskConnection): string {
	return path.join(connection.directory, 'correspondent-session.jsonl')
}

// Prefer the exact pi entry this extension runs inside (deterministic version), falling
// back to PATH when the host argv is not a recognizable pi CLI entry.
export function resolvePiEntry(): { command: string; prefixArgs: string[] } {
	const [, entry] = process.argv
	if (entry && /cli\.[cm]?js$/.test(entry))
		return { command: process.execPath, prefixArgs: [entry] }
	return { command: 'pi', prefixArgs: [] }
}

const ISOLATION_FLAGS = [
	'--no-extensions', // the never-inherit-the-listener rule, enforced by the process boundary
	'--no-skills',
	'--no-prompt-templates',
	'--no-themes',
	'--no-context-files',
	'--tools',
	'read,grep,find,ls',
] as const

export function buildPiArgs(sessionFile: string, prompt: string): string[] {
	return ['-p', ...ISOLATION_FLAGS, '--session', sessionFile, prompt]
}

// The thread must be its OWN pi process, never an embedded one. The owning session
// exports its identity and embedding markers to every child it spawns, and a `pi -p`
// that inherits them attaches to the parent's session protocol instead of running its
// prompt - it blocks forever with no output. Provider, model, reasoning and credential
// variables are deliberately KEPT: the correspondent then answers with the same model
// configuration as the session that owns the desk.
export function correspondentEnv(
	source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const embedded = new Set([
		'PI_CODING_AGENT',
		'PI_SESSION_ID',
		'PI_SESSION_FILE',
	])
	const env: Record<string, string | undefined> = {}
	for (const [name, value] of Object.entries(source)) {
		if (embedded.has(name) || name.startsWith('PI_SUBAGENT_')) continue
		env[name] = value
	}
	return env
}

// `pi -p` treats an OPEN stdin as piped prompt input and waits for its EOF forever;
// execFile's default stdin pipe is exactly that, and the thread then hangs with no
// output - which is why this is spawn with stdio[0] 'ignore' rather than execFile.
export function runPiProcess(
	command: string,
	args: string[],
	options: {
		cwd: string
		env: Record<string, string | undefined>
		signal: AbortSignal
	},
): Promise<string> {
	// A signal that aborted before the spawn never fires the listener below; catch it here so
	// an attachment torn down mid-event cannot leave a process running.
	if (options.signal.aborted)
		return Promise.reject(new Error('the desk correspondent was aborted'))
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		})
		const streams: ThreadStreams = { stdout: '', stderr: '' }
		const fail = (error: Error): void => {
			child.kill('SIGKILL')
			reject(error)
		}
		wireProcess({
			child,
			streams,
			fail,
			signal: options.signal,
			resolve,
			reject,
		})
	})
}

interface WireProcessInput {
	child: ChildProcess
	streams: ThreadStreams
	fail: (error: Error) => void
	signal: AbortSignal
	resolve: (value: string) => void
	reject: (error: Error) => void
}

function wireProcess(input: WireProcessInput): void {
	const { child, streams, fail, signal, resolve, reject } = input
	const onAbort = (): void =>
		fail(new Error('the desk correspondent timed out'))
	signal.addEventListener('abort', onAbort, { once: true })
	const collector =
		(target: 'stdout' | 'stderr') =>
		(chunk: string): void => {
			streams[target] += chunk
			if (
				streams.stdout.length + streams.stderr.length >
				CORRESPONDENT_MAX_OUTPUT_BYTES
			)
				fail(
					new Error(
						'the desk correspondent produced too much output',
					),
				)
		}
	child.stdout?.setEncoding('utf8')
	child.stdout?.on('data', collector('stdout'))
	child.stderr?.setEncoding('utf8')
	child.stderr?.on('data', collector('stderr'))
	child.on('error', error => {
		signal.removeEventListener('abort', onAbort)
		reject(error)
	})
	child.on('close', code => {
		signal.removeEventListener('abort', onAbort)
		if (code === 0) resolve(streams.stdout)
		else
			reject(
				new Error(
					`the correspondent exited with code ${code}: ${streams.stderr.trim().slice(0, STDERR_IN_ERROR_CHARS)}`,
				),
			)
	})
}

export async function runCorrespondent(
	connection: DeskConnection,
	prompt: string,
	signal: AbortSignal,
): Promise<string> {
	const spawnCommand = resolvePiEntry()
	const stdout = await runPiProcess(
		spawnCommand.command,
		[
			...spawnCommand.prefixArgs,
			...buildPiArgs(correspondentSessionFile(connection), prompt),
		],
		{
			cwd: connection.repo,
			env: correspondentEnv(),
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(CORRESPONDENT_TIMEOUT_MS),
			]),
		},
	)
	const text = stdout.trim()
	if (!text) throw new Error('the correspondent returned an empty reply')
	return text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS) : text
}
