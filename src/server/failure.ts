export const DOCS = 'Run `galley spec` for the full agent contract.'

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

// The message an error carries, whatever shape it was thrown in. Routes put it in the response
// body so a caller sees the git/editor/parse failure verbatim.
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
