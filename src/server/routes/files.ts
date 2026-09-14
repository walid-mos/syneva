import { promises as fs } from 'node:fs'

import { blobOid } from '../../git/repo.js'
import { readFileContents } from '../../state/contents.js'
import { resolveContained } from '../containment.js'
import { BAD_PATH, errorMessage } from '../failure.js'
import { HTTP_NOT_FOUND, HTTP_OK, json, fail } from '../http.js'

import type { ApiFailure } from '../failure.js'
import type { RouteRequest } from '../router.js'

// GET /api/file - read an arbitrary repo file, for previewing/commenting on unchanged files. Same
// strict path boundary as /api/file-contents (repo-relative, no escapes).
export async function serveFile({
	ctx,
	res,
	url,
}: RouteRequest): Promise<void> {
	const rel = url.searchParams.get('path') ?? ''
	const resolved = await resolveContained(ctx.state.root, rel)
	if ('error' in resolved && resolved.error === 'escape')
		return fail(res, BAD_PATH)
	const contents =
		'abs' in resolved
			? await fs.readFile(resolved.abs, 'utf8').catch(() => null)
			: null
	if (contents === null) return fail(res, cannotRead(rel))
	json(res, HTTP_OK, { path: rel, contents })
}

// GET /api/file-contents - one reviewed file's old/new contents, fetched on demand so the full
// contents never have to ride /api/state. Resolves from git/the working tree via readFileContents,
// never from embedded copies (the state embeds none).
export async function serveFileContents({
	ctx,
	res,
	url,
}: RouteRequest): Promise<void> {
	const rel = url.searchParams.get('path') ?? ''
	const resolved = await resolveContained(ctx.state.root, rel)
	// Only an ESCAPE is fatal here: a "missing" working-tree file is legitimate because the
	// old/new bytes may come from git (a deleted or index-only file has no working-tree path).
	if ('error' in resolved && resolved.error === 'escape')
		return fail(res, BAD_PATH)
	const file = ctx.state.files.find(candidate => candidate.path === rel)
	if (!file)
		return fail(res, {
			status: HTTP_NOT_FOUND,
			code: 'NOT_FOUND',
			error: `"${rel}" is not part of this review.`,
			fix: 'Reload the desk (GET /api/state) if the diff changed.',
		})
	try {
		// newOid is the file-level staleness key (the new-side blob OID); oldOid is hashed locally
		// from the resolved old side. Carried for a future client cache - the tab ignores them now.
		const { oldContents, newContents } = await readFileContents(
			ctx.state,
			file,
		)
		json(res, HTTP_OK, {
			path: rel,
			oldContents,
			newContents,
			oldOid: blobOid(oldContents),
			newOid: file.contentHash || blobOid(newContents),
		})
	} catch (error) {
		// A git object that can't be read (e.g. rewritten/dropped by a rebase mid-session).
		fail(res, {
			status: HTTP_NOT_FOUND,
			code: 'NOT_FOUND',
			error: `Could not read contents for "${rel}": ${errorMessage(error)}`,
			fix: 'The desk may be stale after a rebase - reload it (GET /api/state).',
		})
	}
}

function cannotRead(rel: string): ApiFailure {
	return {
		status: HTTP_NOT_FOUND,
		code: 'NOT_FOUND',
		error: `Cannot read "${rel}".`,
		fix: 'Check the path is a readable text file in the repo.',
	}
}
