/**
 * Syneva pi extension.
 *
 * Makes this package's `syneva` CLI available to agent sessions with zero
 * global package-manager state:
 * - verifies `dist/cli.js` exists (runs a one-shot build if missing),
 * - keeps a `syneva` shim in `~/.pi/agent/bin` (first directory on PATH)
 *   pointing at this checkout, so prompts, skills, shells, and terminals
 *   can all invoke plain `syneva`.
 * - registers a `/syneva` status command for quick health checks,
 * - registers syneva_agent: a session-owned listener that wakes this Pi session
 *   for questions and completed reviews without a one-shot waiting child.
 *
 * Desks still start via the CLI. Listener resources start only on explicit
 * attachment or restoration and close on session_shutdown, never agent_end.
 */
import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	existsSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerDeskBridge } from '../src/agent/pi-bridge.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(PACKAGE_ROOT, 'dist', 'cli.js')
const BIN_DIR = join(homedir(), '.pi', 'agent', 'bin')
const SHIM = join(BIN_DIR, 'syneva')
// Both the create mode and the explicit chmod need the shim to stay executable.
const SHIM_MODE = 0o755

function shimBody(): string {
	return [
		'#!/bin/sh',
		'# syneva - pi package shim; owned by the syneva pi extension (idempotent).',
		`exec node ${JSON.stringify(CLI)} "$@"`,
		'',
	].join('\n')
}

function writeShim(): 'created' | 'updated' | 'current' {
	let before: string | null = null
	try {
		before = readFileSync(SHIM, 'utf8')
	} catch {
		before = null
	}
	const body = shimBody()
	if (before === body) return 'current'
	mkdirSync(BIN_DIR, { recursive: true })
	writeFileSync(SHIM, body, { mode: SHIM_MODE })
	chmodSync(SHIM, SHIM_MODE) // writeFileSync mode only applies on create
	return before === null ? 'created' : 'updated'
}

function ensureCli(): void {
	if (existsSync(CLI)) return
	// One-shot, bounded: the package was cloned/updated without a build step
	// (e.g. scripts disabled during install). Rebuild with the pinned pnpm.
	execFileSync('pnpm', ['build'], { cwd: PACKAGE_ROOT, stdio: 'ignore' })
	if (!existsSync(CLI))
		throw new Error(`build ran but ${CLI} is still missing`)
}

interface Report {
	version: string
	shim: 'created' | 'updated' | 'current'
	cli: string
}

function setup(): Report {
	ensureCli()
	const shim = writeShim()
	const version = execFileSync('node', [CLI, '--version'], {
		encoding: 'utf8',
	}).trim()
	return { version, shim, cli: CLI }
}

export default function registerSynevaExtension(pi: ExtensionAPI): void {
	registerDeskBridge(pi)
	let report: Report | undefined
	try {
		report = setup()
	} catch (error) {
		process.stderr.write(
			`[syneva-pi] setup failed: ${error instanceof Error ? error.message : String(error)} - ` +
				`the /review and /plan prompts still work; they fall back to "pnpm add -g syneva".\n`,
		)
	}
	pi.registerCommand('syneva', {
		description: 'Syneva review desk status - CLI, shim, package paths',
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				report
					? `syneva v${report.version} - shim: ${SHIM} (${report.shim}) - cli: ${report.cli}`
					: 'syneva setup failed - see pi startup stderr',
				report ? 'info' : 'warning',
			)
		},
	})
}
