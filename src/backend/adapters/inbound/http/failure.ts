export const DOCS = 'Run `syneva spec` for the full agent contract.'

// The wire shape of an error response, and the only place a route failure is described. `fix`
// is what the agent-facing callers act on, so it must say what to do next.
export type ApiFailure = {
	status: number
	code: string
	error: string
	fix: string
}

// The one containment failure shared by every route that takes a repo-relative path
// (/api/file, /api/file-contents, /api/open-editor): the boundary refuses the path the same way
// whichever entry point it arrived through.
export const BAD_PATH: ApiFailure = {
	status: 400,
	code: 'BAD_PATH',
	error: 'Path escapes the repo.',
	fix: 'Use a repo-relative path.',
}

// The one "cannot read a repo path" 404, shared by every route that resolves a repo-relative path
// (/api/file, /api/blob): the same shape and fix hint whichever route missed, so they can't drift.
export function cannotRead(rel: string): ApiFailure {
	return {
		status: 404,
		code: 'NOT_FOUND',
		error: `Cannot read "${rel}".`,
		fix: 'Check the path is a readable file in the repo.',
	}
}
