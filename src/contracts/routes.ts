// The desk's HTTP surface: static asset URLs and API route paths, as one allowlist.
// A neutral dependency sink like the rest of src/contracts - no backend/frontend
// imports, no platform API - so the browser, the agent-facing CLI (desk-client),
// and the HTTP adapter all name their endpoints from the same constants and the
// wire stays in sync by construction.

// Static assets served from the built bundle root (see the http adapter's assets.ts).
export const STATIC_PATHS = {
	index: '/',
	bundle: '/ui.js',
	chunksPrefix: '/chunks/',
	worker: '/worker.js',
	favicon: '/favicon.ico',
} as const

// JSON API routes (the browser tab's fetch surface and the agent CLI's desk-client).
export const API_PATHS = {
	poll: '/api/poll',
	state: '/api/state',
	settings: '/api/settings',
	tree: '/api/tree',
	file: '/api/file',
	blob: '/api/blob',
	fileContents: '/api/file-contents',
	openEditor: '/api/open-editor',
	save: '/api/save',
	send: '/api/send',
	ask: '/api/ask',
	awaitSend: '/api/await-send',
	reload: '/api/reload',
	comment: '/api/comment',
	status: '/api/status',
	reset: '/api/reset',
	stage: '/api/stage',
	stageChange: '/api/stage-change',
	unstage: '/api/unstage',
	shutdown: '/api/shutdown',
} as const
