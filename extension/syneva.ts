/**
 * Syneva pi extension.
 *
 * Makes this package's `syneva` CLI available to agent sessions with zero
 * global package-manager state:
 * - verifies `dist/backend/bootstrap/cli.js` exists (runs a one-shot build if missing),
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
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
// The bridge consumes the built dist artifact: the published package ships only
// dist/ and extension/, so a source-tree import could never resolve once installed.
// Its import must stay dynamic and follow ensureCli(): even a type-only source reference
// would make a clean checkout depend on generated output during type-checking.

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(PACKAGE_ROOT, 'dist', 'backend', 'bootstrap', 'cli.js')
const BRIDGE = join(
	PACKAGE_ROOT,
	'dist',
	'backend',
	'adapters',
	'inbound',
	'pi',
	'pi-bridge.js',
)
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

interface DeskBridgeModule {
	registerDeskBridge(pi: ExtensionAPI): void
}

function isDeskBridgeModule(
	bridgeModule: unknown,
): bridgeModule is DeskBridgeModule {
	return (
		typeof bridgeModule === 'object' &&
		bridgeModule !== null &&
		'registerDeskBridge' in bridgeModule &&
		typeof bridgeModule.registerDeskBridge === 'function'
	)
}

function setup(): Report {
	ensureCli()
	const shim = writeShim()
	const version = execFileSync('node', [CLI, '--version'], {
		encoding: 'utf8',
	}).trim()
	return { version, shim, cli: CLI }
}

async function registerBridge(pi: ExtensionAPI): Promise<void> {
	try {
		const bridge: unknown = await import(pathToFileURL(BRIDGE).href)
		if (!isDeskBridgeModule(bridge))
			throw new Error(
				`built bridge has no registerDeskBridge export: ${BRIDGE}`,
			)
		bridge.registerDeskBridge(pi)
	} catch (error) {
		process.stderr.write(
			`[syneva-pi] bridge load failed: ${error instanceof Error ? error.message : String(error)} - ` +
				`the /review and /plan prompts still work; they fall back to "pnpm add -g syneva".\n`,
		)
	}
}

export default async function registerSynevaExtension(
	pi: ExtensionAPI,
): Promise<void> {
	// Pi awaits async factories, so setup can build the CLI before the bridge loads.
	let report: Report | undefined
	try {
		report = setup()
	} catch (error) {
		process.stderr.write(
			`[syneva-pi] setup failed: ${error instanceof Error ? error.message : String(error)} - ` +
				`the /review and /plan prompts still work; they fall back to "pnpm add -g syneva".\n`,
		)
	}
	if (report) await registerBridge(pi)
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
