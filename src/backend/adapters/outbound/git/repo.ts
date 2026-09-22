import { promises as fs } from 'node:fs'
import path from 'node:path'

import { gitStats } from '../../../domain/diff/git-stats.js'
import { nodeWorkspace } from '../filesystem/workspace.js'

import { git, runGitRaw } from './exec.js'

import type { GitPort } from '../../../application/ports.js'

export { gitStats }

// The node/git implementation of the application's git capability object. Frozen:
// use cases see a readonly port, never this module's mutable surface. The workspace
// facet rides along (the working tree is this adapter's domain - fileAt already reads
// it), so a use case takes one capability object and imports no node:fs itself.
export const nodeGit: GitPort = Object.freeze({
	run: git,
	fileAt,
	rawBlobOids,
	getGitRoot,
	getHead,
	getBranch,
	projectTree: listProjectTree,
	workspace: nodeWorkspace,
})

export async function getGitRoot(cwd: string): Promise<string> {
	return git(['rev-parse', '--show-toplevel'], cwd)
}

export async function getHead(cwd: string): Promise<string | null> {
	try {
		return await git(['rev-parse', 'HEAD'], cwd)
	} catch {
		return null
	}
}

export async function getBranch(cwd: string): Promise<string> {
	try {
		const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
		if (branch && branch !== 'HEAD') return branch
		const short = await git(['rev-parse', '--short', 'HEAD'], cwd)
		return short ? `detached-${short}` : ''
	} catch {
		return ''
	}
}

// One reviewed file's contents at a ref (git blob) or from the working tree. By default a missing
// object/file swallows to "" - for the diff a vanished side degrades to an add/delete rather than
// crashing. `strict` (used by on-demand content resolution for a side the diff says MUST exist)
// rethrows instead, so /api/file-contents can 404 with a reload hint when a rebase drops the object
// mid-session, instead of silently serving an empty file.
export async function fileAt(
	root: string,
	rel: string | undefined,
	ref?: string,
	isStrict = false,
): Promise<string> {
	if (!rel) return ''
	gitStats.fileReads++
	gitStats.readsInFlight++
	gitStats.peakReadsInFlight = Math.max(
		gitStats.peakReadsInFlight,
		gitStats.readsInFlight,
	)
	try {
		// Raw exec (not git()) so the trailing newline is preserved - otherwise the file
		// looks like it has "no newline at end of file" and the last line renders as a
		// spurious diff.
		if (ref) return await runGitRaw(['show', `${ref}:${rel}`], root)
		return await fs.readFile(path.join(root, rel), 'utf8')
	} catch (error) {
		if (isStrict) throw error
		return ''
	} finally {
		gitStats.readsInFlight--
	}
}

// A blob OID git reports as all-zeros - the working-tree side of a dirty/untracked file, which has
// no stored object yet. Signals "hash the working copy locally" (blobOid) rather than harvest.
function isZeroOid(oid: string): boolean {
	return /^0+$/.test(oid)
}

type RawDiffQuery = {
	staged?: boolean
	base?: string
	path?: string
}

// Harvest per-file new-side blob OIDs from `git diff --raw` in ONE process (not a `git show`
// per file), for the same args the patch diff was taken with. Only useful where the new side is
// committed (pr: HEAD; staged repo: the index) - a plain working-tree side comes back all-zeros
// and is dropped here so the caller falls back to blobOid(workingCopy). Keyed by new path (the
// rename target, since -M pairs the halves). Full 40-hex via --no-abbrev; -z tolerates spaces.
export async function rawBlobOids(
	root: string,
	query: RawDiffQuery,
): Promise<Map<string, string>> {
	const args = ['diff', '--no-ext-diff', '-M', '--raw', '-z', '--no-abbrev']
	if (query.staged) args.push('--cached')
	if (query.base) args.push(`${query.base}..HEAD`)
	if (query.path) args.push('--', query.path)
	const raw = await git(args, root).catch(() => '')
	const tokens = raw.split('\0').filter(token => token.length > 0)
	const oids = new Map<string, string>()
	let index = 0
	while (index < tokens.length) {
		const meta = tokens[index]
		index++
		if (!meta.startsWith(':')) continue
		// ":<oldmode> <newmode> <oldsha> <newsha> <status>" - R/C consumes old+new paths.
		const fields: (string | undefined)[] = meta.slice(1).split(' ')
		const [, , , newOid, rawStatus] = fields
		if (rawStatus?.startsWith('R') || rawStatus?.startsWith('C')) index++ // skip the old path
		const newPath = tokens[index]
		index++
		if (newPath && newOid && !isZeroOid(newOid)) oids.set(newPath, newOid)
	}
	return oids
}

export async function listProjectTree(root: string): Promise<string[]> {
	try {
		const tracked = await git(['ls-files'], root)
		return tracked
			.split(/\r?\n/)
			.filter(Boolean)
			.toSorted((a, b) => a.localeCompare(b))
	} catch {
		return []
	}
}
