import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
	currentVersion,
	detectInstall,
	isNewer,
	readCheckCache,
	writeCheckCache,
} from './update.js'

void test('isNewer compares plain x.y.z numerically', () => {
	assert.equal(isNewer('0.3.0', '0.2.1'), true)
	assert.equal(isNewer('1.0.0', '0.99.99'), true)
	assert.equal(isNewer('0.2.10', '0.2.9'), true) // numeric, not lexicographic
	assert.equal(isNewer('0.2.1', '0.2.1'), false)
	assert.equal(isNewer('0.2.0', '0.2.1'), false)
	assert.equal(isNewer('0.2.1', '0.3.0'), false)
})

void test("isNewer refuses anything that isn't plain semver", () => {
	assert.equal(isNewer('0.3.0-beta.1', '0.2.1'), false)
	assert.equal(isNewer('latest', '0.2.1'), false)
	assert.equal(isNewer('0.3', '0.2.1'), false)
	assert.equal(isNewer('', ''), false)
})

void test('currentVersion reads the package version', () => {
	assert.match(currentVersion(), /^\d+\.\d+\.\d+/)
})

void test('detectInstall: project-local installs are notice-only', () => {
	const cwd = '/work/repo'
	const local = detectInstall(
		'/work/repo/node_modules/syneva/dist/backend/bootstrap/cli.js',
		cwd,
	)
	assert.equal(local.kind, 'local')
	assert.ok(
		isDeepStrictEqual(local.command, ['npm', 'i', '-D', 'syneva@latest']),
	)
})

void test('detectInstall: global installs pick the manager from the path', () => {
	const cwd = '/work/repo'
	assert.deepEqual(
		detectInstall(
			'/usr/local/lib/node_modules/syneva/dist/backend/bootstrap/cli.js',
			cwd,
		),
		{
			kind: 'global',
			command: ['npm', 'i', '-g', 'syneva@latest'],
		},
	)
	assert.deepEqual(
		detectInstall(
			'/Users/u/Library/pnpm/global/5/.pnpm/syneva@0.2.1/node_modules/syneva/dist/backend/bootstrap/cli.js',
			cwd,
		),
		{
			kind: 'global',
			command: ['pnpm', 'add', '-g', 'syneva@latest'],
		},
	)
	assert.deepEqual(
		detectInstall(
			'/Users/u/.bun/install/global/node_modules/syneva/dist/backend/bootstrap/cli.js',
			cwd,
		),
		{
			kind: 'global',
			command: ['bun', 'add', '-g', 'syneva@latest'],
		},
	)
})

void test('update-check cache: round-trip; missing/corrupt read as {}', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'syneva-update-'))
	const prevHome = process.env.HOME
	const prevProfile = process.env.USERPROFILE
	process.env.HOME = home
	process.env.USERPROFILE = home
	try {
		assert.deepEqual(await readCheckCache(), {})
		await writeCheckCache({
			lastCheckedAt: '2026-06-11T00:00:00.000Z',
			latest: '9.9.9',
		})
		assert.deepEqual(await readCheckCache(), {
			lastCheckedAt: '2026-06-11T00:00:00.000Z',
			latest: '9.9.9',
		})
		await fs.writeFile(
			path.join(home, '.syneva', 'update-check.json'),
			'{nope',
			'utf8',
		)
		assert.deepEqual(await readCheckCache(), {})
	} finally {
		process.env.HOME = prevHome
		process.env.USERPROFILE = prevProfile
		await fs.rm(home, { recursive: true, force: true })
	}
})
