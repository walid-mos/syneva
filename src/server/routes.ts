import {
	askQuestion,
	awaitEvent,
	postStatus,
	stopDesk,
} from './routes/agent.js'
import { serveBlob } from './routes/blob.js'
import {
	servePoll,
	serveSettings,
	serveState,
	serveTree,
	saveSettings,
} from './routes/desk.js'
import { openInEditor } from './routes/editor.js'
import { serveFile, serveFileContents } from './routes/files.js'
import { reloadDeskFromRequest } from './routes/reload.js'
import {
	addComment,
	resetDesk,
	saveReview,
	sendReviewToAgent,
} from './routes/review.js'
import { stageFiles, stageOneChange, unstageFile } from './routes/staging.js'
import {
	serveFavicon,
	serveIndex,
	serveUiBundle,
	serveUiChunk,
	serveWorkerBundle,
} from './routes/static.js'

import type { RouteTable } from './router.js'

// The desk's one route registry: `METHOD /path` → its handler. A new route is an entry here plus its
// module; the dispatcher, the origin guard, and the 500 handler cover it without further edits.
export const routes: RouteTable = {
	'GET /': serveIndex,
	'GET /ui.js': serveUiBundle,
	'GET /chunks/*': serveUiChunk,
	'GET /worker.js': serveWorkerBundle,
	'GET /favicon.ico': serveFavicon,
	'GET /api/poll': servePoll,
	'GET /api/state': serveState,
	'GET /api/settings': serveSettings,
	'POST /api/settings': saveSettings,
	'GET /api/tree': serveTree,
	'GET /api/file': serveFile,
	'GET /api/blob': serveBlob,
	'GET /api/file-contents': serveFileContents,
	'POST /api/open-editor': openInEditor,
	'POST /api/save': saveReview,
	'POST /api/send': sendReviewToAgent,
	'POST /api/ask': askQuestion,
	'GET /api/await-send': awaitEvent,
	'POST /api/reload': reloadDeskFromRequest,
	'POST /api/comment': addComment,
	'POST /api/status': postStatus,
	'POST /api/reset': resetDesk,
	'POST /api/stage': stageFiles,
	'POST /api/stage-change': stageOneChange,
	'POST /api/unstage': unstageFile,
	'POST /api/shutdown': stopDesk,
}
