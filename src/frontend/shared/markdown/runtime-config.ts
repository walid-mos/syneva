// The markdown loader's composed runtime behaviour, configured once by app
// composition (configureMarkdownRuntime is the only module allowed to know those
// app-side behaviours - see shared/markdown/index.ts). Kept apart from index.ts so
// the engine can read the configuration without a cycle through the lazy loader.
export type MarkdownRuntime = {
	getTheme: () => string
	onLoaded: () => void
	onLoadError: () => void
	// Resolves a repo-relative asset src to its desk URL. The blob route is named
	// only by the review-file entity API boundary; shared infrastructure receives
	// this resolver injected - the default passes sources through untouched.
	repoImageSrc: (src: string) => string
}

let runtime: MarkdownRuntime = {
	getTheme: () => '',
	onLoaded: () => {},
	onLoadError: () => {},
	repoImageSrc: src => src,
}

export function configureMarkdownRuntime(configured: MarkdownRuntime): void {
	runtime = configured
}

export function markdownRuntime(): MarkdownRuntime {
	return runtime
}
