import path from 'node:path'

import type { WorkspacePort } from './ports.js'

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
// so an in-repo symlink pointing outside the repo passes it and a read then follows
// the link off-tree. Realpath both the target and the root, then re-check containment
// (mirrors the working-tree read in contents.ts). "missing" (realpath ENOENT) stays
// distinct from "escape" so a route can 404 a nonexistent file while /api/file-contents
// still serves a file whose bytes come from git (deleted / index-only), not the working
// tree. The symlink resolution itself is the workspace port's - no fs in the application.
export async function resolveContained(
	root: string,
	rel: string,
	workspace: WorkspacePort,
): Promise<ContainedPath> {
	const resolvedRoot = (await workspace.realpath(root)) ?? path.resolve(root)
	const abs = path.resolve(resolvedRoot, rel)
	if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep))
		return { error: 'escape' }
	const real = await workspace.realpath(abs)
	if (real === null) return { error: 'missing' }
	if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep))
		return { error: 'escape' }
	return { abs: real }
}
