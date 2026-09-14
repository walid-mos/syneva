import { promises as fs } from 'node:fs'
import path from 'node:path'

// Repo-relative path → absolute, or null if it is absolute or escapes the repo.
// /api/open-editor hands this to a local process, so the boundary must be strict.
export function repoPath(root: string, rel: string): string | null {
	if (path.isAbsolute(rel)) return null
	const resolvedRoot = path.resolve(root)
	const abs = path.resolve(resolvedRoot, rel)
	if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep))
		return null
	return abs
}

export type ContainedPath = { abs: string } | { error: 'escape' | 'missing' }

// Resolve a repo-relative path to an absolute one that provably stays inside the repo
// AFTER symlinks are followed. The plain startsWith check runs on the UNRESOLVED path,
// so an in-repo symlink pointing outside the repo passes it and readFile then follows
// the link off-tree. Mirror the working-tree read in state/contents.ts: realpath the target and
// the root, then re-check containment. "missing" (realpath ENOENT) stays distinct from
// "escape" so a route can 404 a nonexistent file while /api/file-contents still serves
// a file whose bytes come from git (deleted / index-only), not the working tree.
export async function resolveContained(
	root: string,
	rel: string,
): Promise<ContainedPath> {
	const resolvedRoot = await fs.realpath(root).catch(() => path.resolve(root))
	const abs = path.resolve(resolvedRoot, rel)
	if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep))
		return { error: 'escape' }
	const real = await fs.realpath(abs).catch(() => null)
	if (real === null) return { error: 'missing' }
	if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep))
		return { error: 'escape' }
	return { abs: real }
}
