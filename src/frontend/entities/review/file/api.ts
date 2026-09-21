import { API_PATHS } from '@contracts/routes'
import { api } from '@shared/api/client'
import {
	assertObject,
	optString,
	requiredString,
	requiredStringArray,
} from '@shared/api/decode'

// The review-file entity's API boundary: per-file/tree/blob endpoints, named only here.
// Responses are decoded onto explicit shapes - the wire never escapes this module.

// The changed-file listing for the project tree (paths only; review state comes from /api/state).
export type TreeListing = { files: string[] }

export const fetchTree = async (): Promise<TreeListing> => {
	const raw = await api(API_PATHS.tree)
	const o = assertObject(raw, API_PATHS.tree)
	return { files: requiredStringArray(o, 'files', API_PATHS.tree) }
}

// One file's old/new contents (see file/contents.ts's per-file LRU).
export type FileContents = { oldContents: string; newContents: string }

export const fetchFileContents = async (
	path: string,
): Promise<FileContents> => {
	const endpoint = `${API_PATHS.fileContents}?path=${encodeURIComponent(path)}`
	const raw = await api(endpoint)
	const o = assertObject(raw, endpoint)
	// Surface a server-side failure message before the field checks: empty strings are
	// VALID sides (added file -> empty old, deleted file -> empty new, empty file -> both),
	// so only an absent field is a decode failure - never test the strings for truthiness.
	const error = optString(o, 'error', endpoint)
	if (error) throw new Error(error)
	return {
		oldContents: requiredString(o, 'oldContents', endpoint),
		newContents: requiredString(o, 'newContents', endpoint),
	}
}

// A repo-relative file asset on the desk's blob route. This boundary is the only place
// the /api/blob path is spelled; shared consumers (the markdown runtime) receive this
// resolver injected instead of the route itself.
export const repoBlobUrl = (path: string): string =>
	`${API_PATHS.blob}?path=${encodeURIComponent(path)}`

// Read an unchanged file through /api/file to preview it (old === new, no diff).
export type PreviewPayload = { path: string; contents: string }

export const fetchPreviewFile = async (
	path: string,
): Promise<PreviewPayload> => {
	const endpoint = `${API_PATHS.file}?path=${encodeURIComponent(path)}`
	const raw = await api(endpoint)
	const o = assertObject(raw, endpoint)
	return {
		path: requiredString(o, 'path', endpoint),
		contents: requiredString(o, 'contents', endpoint),
	}
}
