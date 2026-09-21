// Application-owned error the outbound adapters raise when a native/platform
// failure crosses into a use case. The adapter keeps the original message (so
// callers' user-facing wording is unchanged) and chains the underlying failure as
// `cause`, preserving the whole diagnostic chain.

export class AdapterError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'AdapterError'
	}
}

// The message an error carries, whatever shape it was thrown in. Shared by the use
// cases that surface a staged-patch conflict and by the HTTP failure responses.
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
