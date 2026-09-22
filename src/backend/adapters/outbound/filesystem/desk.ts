import { promises as fs } from 'node:fs'
import path from 'node:path'

import { decodeDeskLock } from '../../../domain/desk-lock.js'
import { hash, sanitizeSession } from '../../../domain/identity.js'

import type { DeskLockPort, SettingsPort } from '../../../application/ports.js'
import type { DeskLock } from '../../../domain/desk-lock.js'

const SYNEVA_DIR = '.syneva'
const SETTINGS_FILE = 'settings.json'
const DESK_LOCK_FILE = 'desk.lock'
const JSON_INDENT = 2

export type { DeskLock }

// The user's home directory, falling back to `fallback` when neither env var is set. An empty
// HOME/USERPROFILE means "unset" (a shell can export it empty), so this is a presence check, not a
// nullish one.
export function homeDir(fallback: string): string {
	const home = process.env.HOME
	if (home) return home
	const profile = process.env.USERPROFILE
	if (profile) return profile
	return fallback
}

// Where a desk's reviews for one repo+session live: ~/.syneva/<repo hash>/<session>. Created on
// demand - every writer of a review or a lock starts here.
export async function reviewDir(
	root: string,
	session: string,
): Promise<string> {
	const dir = path.join(
		homeDir(root),
		SYNEVA_DIR,
		hash(root),
		sanitizeSession(session),
	)
	await fs.mkdir(dir, { recursive: true })
	return dir
}

export function deskLockPath(dir: string): string {
	return path.join(dir, DESK_LOCK_FILE)
}

export async function readDeskLock(
	root: string,
	session: string,
): Promise<DeskLock | null> {
	try {
		const raw = await fs.readFile(
			deskLockPath(await reviewDir(root, session)),
			'utf8',
		)
		const parsed: unknown = JSON.parse(raw)
		return decodeDeskLock(parsed)
	} catch {
		return null
	}
}

function isDeskProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

// Live desks for this repo (across all sessions), used to auto-target
// await/comment/reload when --session isn't given. A lock whose pid is dead is
// debris from a crash/SIGKILL (only a clean exit unlinks it) - sweep it here so
// stale locks don't accumulate under ~/.syneva across sessions.
export async function findLiveDesks(root: string): Promise<DeskLock[]> {
	const base = path.join(homeDir(root), SYNEVA_DIR, hash(root))
	const sessions = await fs.readdir(base).catch(() => [])
	const locks = await Promise.all(
		sessions.map(session => readLiveDesk(root, session)),
	)
	return locks.filter((lock): lock is DeskLock => lock !== null)
}

// The session's lock when its desk is still running, else null - sweeping the debris of a dead pid
// on the way out.
async function readLiveDesk(
	root: string,
	session: string,
): Promise<DeskLock | null> {
	const lock = await readDeskLock(root, session)
	if (!lock) return null
	if (isDeskProcessAlive(lock.pid)) return lock
	await fs
		.unlink(deskLockPath(await reviewDir(root, session)))
		.catch(() => undefined)
	return null
}

// Global display preferences (~/.syneva/settings.json) - deliberately NOT per-repo or
// per-session: these are the reviewer's, and the desk's random port makes browser
// localStorage useless for them (origin changes every launch).
export function globalSettingsPath(): string {
	return path.join(homeDir(process.cwd()), SYNEVA_DIR, SETTINGS_FILE)
}

export async function readGlobalSettings(): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(
			await fs.readFile(globalSettingsPath(), 'utf8'),
		)
		return toSettings(parsed)
	} catch {
		return {} // missing or corrupt → client falls back to defaults
	}
}

// The filesystem adapter's implementation of the application's settings capability: the same
// global ~/.syneva/settings.json the desk's editor template reads, exposed read/write for the
// tab's Settings dialog.
export const nodeSettings = Object.freeze({
	read: readGlobalSettings,
	write: writeGlobalSettings,
}) satisfies SettingsPort

// writeGlobalSettings always writes a JSON object, so anything else in the file (a bare value, an
// array) is not a settings body and the client keeps its defaults.
function toSettings(parsed: unknown): Record<string, unknown> {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		return {}
	return { ...parsed }
}

export async function writeGlobalSettings(settings: unknown): Promise<void> {
	const file = globalSettingsPath()
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(
		file,
		`${JSON.stringify(settings, null, JSON_INDENT)}\n`,
		'utf8',
	)
}

// The filesystem adapter's implementation of the application's desk-lock capability.
// Frozen like nodeGit/nodeReviewStore: consumers see a readonly port.
export const nodeDeskLocks: DeskLockPort = Object.freeze({
	read: readDeskLock,
	findLive: findLiveDesks,
	// Parameters annotated explicitly: Object.freeze drops the port's contextual typing,
	// so the arrow would otherwise infer implicit anys.
	remove: async (root: string, session: string) => {
		await fs
			.unlink(deskLockPath(await reviewDir(root, session)))
			.catch(() => undefined)
	},
})
