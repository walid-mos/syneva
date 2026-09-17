import { spawn } from 'node:child_process'
import { promises as fs, realpathSync, readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { warn } from './output.js'
import { homeDir } from './state/desk.js'

import type { ChildProcess } from 'node:child_process'

// ── Update check + confirmed auto-update ─────────────────────────────────────
// Runs once at desk launch (never on the agent subcommands - await/comment/reload
// run in agent loops with JSON stdout and must never block on a prompt). When npm
// has a newer version: prompt on a TTY and, on confirm, run the package manager
// update and re-exec the same command so the desk opens on the new version. Every
// failure path is silent or a one-line warning - an update check must never break
// a launch.

const PKG = 'syneva'

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000

// one registry hit per day
const CHECK_TTL_MS =
	HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND
const FETCH_TIMEOUT_MS = 2500

// Registry used when SYNEVA_REGISTRY_URL is unset (tests point it at a local server).
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

// x.y.z is exactly three dot-separated parts.
const SEMVER_PART_COUNT = 3
const JSON_INDENT = 2

export function currentVersion(): string {
	try {
		const pkg: unknown = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		)
		if (typeof pkg !== 'object' || pkg === null) return ''
		if (!('version' in pkg)) return ''
		return typeof pkg.version === 'string' ? pkg.version : ''
	} catch {
		return ''
	}
}

type VersionParts = [number, number, number]

function toVersionPart(rawPart: string): number | null {
	if (!/^\d+$/.test(rawPart)) return null
	return Number(rawPart)
}

// Plain numeric x.y.z compare - no prerelease ordering (a prerelease segment makes the
// numeric parse fail -> false). Good enough: syneva publishes plain semver.
function parseVersion(rawVersion: string): VersionParts | null {
	const parts = rawVersion.trim().split('.')
	if (parts.length !== SEMVER_PART_COUNT) return null
	const [rawMajor, rawMinor, rawPatch] = parts
	const major = toVersionPart(rawMajor)
	const minor = toVersionPart(rawMinor)
	const patch = toVersionPart(rawPatch)
	if (major === null || minor === null || patch === null) return null
	return [major, minor, patch]
}

export function isNewer(latest: string, current: string): boolean {
	const next = parseVersion(latest)
	const installed = parseVersion(current)
	if (!next || !installed) return false
	for (let index = 0; index < SEMVER_PART_COUNT; index++) {
		const candidate = next[index]
		const existing = installed[index]
		if (candidate !== existing) return candidate > existing
	}
	return false
}

export type InstallInfo = {
	kind: 'global' | 'local'
	// The command that updates this install - run on confirm (global) or shown (local).
	command: string[]
}

// Where this CLI lives decides how (and whether) we update it. A path inside the
// current project's node_modules is a local install (devDependency / npx): never
// touch the project's package.json/lockfile - suggest the command instead. Anything
// else is treated as global, with the manager inferred from the install path.
export function detectInstall(
	cliPath: string,
	cwd = process.cwd(),
): InstallInfo {
	const local = path.join(cwd, 'node_modules') + path.sep
	if (cliPath.startsWith(local))
		return { kind: 'local', command: ['npm', 'i', '-D', `${PKG}@latest`] }
	const installPath = cliPath.toLowerCase()
	if (installPath.includes('pnpm'))
		return {
			kind: 'global',
			command: ['pnpm', 'add', '-g', `${PKG}@latest`],
		}
	if (installPath.includes(`${path.sep}.bun${path.sep}`))
		return {
			kind: 'global',
			command: ['bun', 'add', '-g', `${PKG}@latest`],
		}
	if (installPath.includes('yarn'))
		return {
			kind: 'global',
			command: ['yarn', 'global', 'add', `${PKG}@latest`],
		}
	return { kind: 'global', command: ['npm', 'i', '-g', `${PKG}@latest`] }
}

// ── 24h throttle cache (~/.syneva/update-check.json) ─────────────────────────
function cachePath(): string {
	return path.join(homeDir(process.cwd()), '.syneva', 'update-check.json')
}

type CheckCache = { lastCheckedAt?: string; latest?: string }

function toCheckCache(parsed: unknown): CheckCache {
	if (typeof parsed !== 'object' || parsed === null) return {}
	const cache: CheckCache = {}
	if ('lastCheckedAt' in parsed && typeof parsed.lastCheckedAt === 'string')
		cache.lastCheckedAt = parsed.lastCheckedAt
	if ('latest' in parsed && typeof parsed.latest === 'string')
		cache.latest = parsed.latest
	return cache
}

export async function readCheckCache(): Promise<CheckCache> {
	try {
		const parsed: unknown = JSON.parse(
			await fs.readFile(cachePath(), 'utf8'),
		)
		return toCheckCache(parsed)
	} catch {
		return {}
	}
}

export async function writeCheckCache(cache: CheckCache): Promise<void> {
	try {
		await fs.mkdir(path.dirname(cachePath()), { recursive: true })
		await fs.writeFile(
			cachePath(),
			`${JSON.stringify(cache, null, JSON_INDENT)}\n`,
			'utf8',
		)
	} catch {
		/* a failed cache write must not break the launch */
	}
}

// The registry to ask, overridable for tests/local mirrors. An empty SYNEVA_REGISTRY_URL means
// "unset" (a shell can export it empty), so this is a presence check, not a nullish one.
function registryBase(): string {
	const configured = process.env.SYNEVA_REGISTRY_URL
	if (configured) return configured
	return DEFAULT_REGISTRY
}

async function fetchLatestVersion(): Promise<string | null> {
	const base = registryBase()
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
	try {
		const res = await fetch(`${base}/${encodeURIComponent(PKG)}/latest`, {
			signal: ctrl.signal,
		})
		if (!res.ok) return null
		const body: unknown = await res.json()
		if (typeof body !== 'object' || body === null) return null
		if (!('version' in body) || typeof body.version !== 'string')
			return null
		return body.version
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

// Latest published version, via the daily cache; null when unknown.
async function resolveLatest(): Promise<string | null> {
	const cache = await readCheckCache()
	const isFresh =
		cache.lastCheckedAt &&
		Date.now() - Date.parse(cache.lastCheckedAt) < CHECK_TTL_MS
	if (isFresh) return cache.latest ?? null
	const latest = await fetchLatestVersion()
	if (latest)
		await writeCheckCache({
			lastCheckedAt: new Date().toISOString(),
			latest,
		})
	return latest
}

function promptYesNo(question: string): Promise<boolean> {
	return new Promise(resolve => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
		})
		rl.question(question, answer => {
			rl.close()
			resolve(!/^n/i.test(answer.trim())) // empty = yes
		})
	})
}

async function runCommand(command: string[]): Promise<number> {
	const [binary, ...args] = command
	if (!binary) return 1
	const child = spawn(binary, args, { stdio: 'inherit' })
	return waitForExit(child)
}

function waitForExit(child: ChildProcess): Promise<number> {
	return new Promise(resolve => {
		let isSettled = false
		const settle = (code: number): void => {
			if (isSettled) return
			isSettled = true
			resolve(code)
		}
		child.on('error', () => settle(1))
		child.on('close', code => settle(code ?? 0))
	})
}

// Check for a newer release and offer to update. Called only from desk starts.
// On a confirmed global update this re-execs the same command on the new version
// and never returns (the parent lingers only to forward the child's exit code).
export async function maybeOfferUpdate(): Promise<void> {
	if (process.env.SYNEVA_NO_UPDATE_CHECK || process.env.SYNEVA_UPDATE_REEXEC)
		return
	const current = currentVersion()
	const latest = await resolveLatest()
	if (!latest || !current || !isNewer(latest, current)) return

	let cliPath = process.argv[1] ?? ''
	try {
		cliPath = realpathSync(cliPath) // bin shims are symlinks into the package
	} catch {
		/* keep the raw path */
	}
	const install = detectInstall(cliPath)
	const suggestion = install.command.join(' ')

	const isInteractive = process.stdin.isTTY && process.stderr.isTTY
	if (!isInteractive || install.kind === 'local') {
		warn(
			`Syneva update available: ${current} -> ${latest}. Run \`${suggestion}\`.`,
		)
		return
	}

	const isConfirmed = await promptYesNo(
		`Syneva ${latest} is available (you have ${current}). Update now? [Y/n] `,
	)
	if (!isConfirmed) return

	warn(`Updating: ${suggestion}`)
	const code = await runCommand(install.command)
	if (code !== 0) {
		warn(`Update failed (exit ${code}) - continuing on ${current}.`)
		return
	}
	// Relaunch the same command on the new version. argv[1] is the bin path, which the
	// package manager just repointed at the new code; the env flag stops a check loop.
	warn(`Updated to ${latest} - relaunching...`)
	const child = spawn(process.execPath, process.argv.slice(1), {
		stdio: 'inherit',
		env: { ...process.env, SYNEVA_UPDATE_REEXEC: '1' },
	})
	process.exit(await waitForExit(child))
}
