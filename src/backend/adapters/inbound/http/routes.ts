import { API_PATHS, STATIC_PATHS } from '../../../../contracts/routes.js'

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

// The desk's one route registry: `METHOD /path` → its handler. Paths come from
// src/contracts/routes.ts (the shared wire allowlist); a new route is an entry
// here plus its module; the dispatcher, the origin guard, and the 500 handler
// cover it without further edits.
export const routes: RouteTable = {
	[`GET ${STATIC_PATHS.index}`]: serveIndex,
	[`GET ${STATIC_PATHS.bundle}`]: serveUiBundle,
	[`GET ${STATIC_PATHS.chunksPrefix}*`]: serveUiChunk,
	[`GET ${STATIC_PATHS.worker}`]: serveWorkerBundle,
	[`GET ${STATIC_PATHS.favicon}`]: serveFavicon,
	[`GET ${API_PATHS.poll}`]: servePoll,
	[`GET ${API_PATHS.state}`]: serveState,
	[`GET ${API_PATHS.settings}`]: serveSettings,
	[`POST ${API_PATHS.settings}`]: saveSettings,
	[`GET ${API_PATHS.tree}`]: serveTree,
	[`GET ${API_PATHS.file}`]: serveFile,
	[`GET ${API_PATHS.blob}`]: serveBlob,
	[`GET ${API_PATHS.fileContents}`]: serveFileContents,
	[`POST ${API_PATHS.openEditor}`]: openInEditor,
	[`POST ${API_PATHS.save}`]: saveReview,
	[`POST ${API_PATHS.send}`]: sendReviewToAgent,
	[`POST ${API_PATHS.ask}`]: askQuestion,
	[`GET ${API_PATHS.awaitSend}`]: awaitEvent,
	[`POST ${API_PATHS.reload}`]: reloadDeskFromRequest,
	[`POST ${API_PATHS.comment}`]: addComment,
	[`POST ${API_PATHS.status}`]: postStatus,
	[`POST ${API_PATHS.reset}`]: resetDesk,
	[`POST ${API_PATHS.stage}`]: stageFiles,
	[`POST ${API_PATHS.stageChange}`]: stageOneChange,
	[`POST ${API_PATHS.unstage}`]: unstageFile,
	[`POST ${API_PATHS.shutdown}`]: stopDesk,
}
