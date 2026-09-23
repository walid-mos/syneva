import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AdapterError, errorMessage } from '../../../application/errors.js'

import type { WorkspacePort } from '../../../application/ports.js'

// The node/filesystem implementation of the application's working-tree capability
// object. Frozen: use cases see a readonly port, never this module's internals.

export async function realpath(target: string): Promise<string | null> {
	try {
		return await fs.realpath(target)
	} catch {
		return null
	}
}

export async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isDirectory()
	} catch {
		return false
	}
}

export async function readFile(target: string): Promise<string | null> {
	try {
		return await fs.readFile(target, 'utf8')
	} catch {
		return null
	}
}

// Unique temp file under the OS temp dir (mkdtemp, not $TMPDIR-or-/tmp: Windows sets
// TEMP/TMP instead, so the old fallback resolved to a nonexistent C:\tmp and mkdtemp
// ENOENT'd there - hunk staging failed on Windows). Same-directory rename semantics
// don't apply here; the file only has to live long enough for one `git apply`.
export async function writeTempFile(contents: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'syneva-'))
	const file = path.join(dir, `${crypto.randomUUID()}.diff`)
	try {
		await fs.writeFile(file, contents, 'utf8')
	} catch (error) {
		await fs
			.rm(dir, { recursive: true, force: true })
			.catch(() => undefined)
		throw new AdapterError(errorMessage(error), { cause: error })
	}
	return file
}

export async function removeTempDir(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

export const nodeWorkspace: WorkspacePort = Object.freeze({
	realpath,
	isDirectory,
	readFile,
	writeTempFile,
	removeTempDir,
})
