import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
	deskLockPath,
	findLiveDesks,
	globalSettingsPath,
	readGlobalSettings,
	reviewDir,
	writeGlobalSettings,
} from './desk.js'
import { sanitizeSession, stablePort } from './identity.js'

void test('global settings: write→read round-trip; missing and corrupt files read as {}', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'syneva-settings-'))
	const prevHome = process.env.HOME
	const prevProfile = process.env.USERPROFILE
	process.env.HOME = home
	process.env.USERPROFILE = home
	try {
		assert.deepEqual(await readGlobalSettings(), {}) // no file yet
		await writeGlobalSettings({
			settings: { theme: 'pierre-dark' },
			diffStyle: 'unified',
		})
		assert.deepEqual(await readGlobalSettings(), {
			settings: { theme: 'pierre-dark' },
			diffStyle: 'unified',
		})
		await fs.writeFile(globalSettingsPath(), '{not json', 'utf8')
		assert.deepEqual(await readGlobalSettings(), {}) // corrupt → defaults
	} finally {
		process.env.HOME = prevHome
		process.env.USERPROFILE = prevProfile
		await fs.rm(home, { recursive: true, force: true })
	}
})

void test('findLiveDesks sweeps locks whose pid is dead and keeps live ones', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'syneva-locks-'))
	const prevHome = process.env.HOME
	const prevProfile = process.env.USERPROFILE
	process.env.HOME = home
	process.env.USERPROFILE = home
	const root = '/work/lock-sweep-repo'
	const writeLock = async (session: string, pid: number): Promise<void> =>
		fs.writeFile(
			deskLockPath(await reviewDir(root, session)),
			`${JSON.stringify({
				pid,
				url: 'http://127.0.0.1:1/',
				session,
				startedAt: 't',
			})}\n`,
			'utf8',
		)
	try {
		// Our own pid is definitely alive; a crashed desk's pid is definitely dead.
		await writeLock('alive', process.pid)
		await writeLock('crashed', 2 ** 22 - 1) // beyond real pid ranges → kill(pid,0) throws
		const live = await findLiveDesks(root)
		assert.ok(
			isDeepStrictEqual(
				live.map(l => l.session),
				['alive'],
			),
		)
		const staleLock = deskLockPath(await reviewDir(root, 'crashed'))
		assert.equal(
			await fs.stat(staleLock).then(
				() => true,
				() => false,
			),
			false,
			'stale lock swept',
		)
	} finally {
		process.env.HOME = prevHome
		process.env.USERPROFILE = prevProfile
		await fs.rm(home, { recursive: true, force: true })
	}
})

void test('stablePort is deterministic per repo+session and stays in range', () => {
	const a = stablePort('/work/repo', 'main')
	assert.ok(Object.is(a, stablePort('/work/repo', 'main'))) // deterministic
	assert.ok(a >= 41000 && a < 51000)
	assert.notEqual(a, stablePort('/work/repo', 'feature-x')) // session-sensitive
	assert.notEqual(a, stablePort('/other/repo', 'main')) // repo-sensitive
	// The raw session name and its sanitized form land on the same port (deskSession sanitizes).
	assert.ok(
		Object.is(
			stablePort('/work/repo', 'feature/x'),
			stablePort('/work/repo', 'feature-x'),
		),
	)
})

void test('sanitizeSession normalizes branch names and falls back', () => {
	assert.equal(sanitizeSession('feature/x'), 'feature-x')
	assert.equal(sanitizeSession('--weird--'), 'weird')
	assert.equal(sanitizeSession('ok.name_1'), 'ok.name_1')
	assert.equal(sanitizeSession(''), 'review')
	assert.equal(sanitizeSession('///'), 'review')
})
