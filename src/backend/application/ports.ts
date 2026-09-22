// Application-owned ports: the narrow readonly capability objects the use cases
// consume. Use cases never import concrete outbound adapters - the composition
// roots (bootstrap) and inbound adapters wire these from the adapters.
//
// Only earned capabilities are listed: each member exists because a use case in
// this layer calls it. Timestamps and ids are NOT ported - application code reads
// them directly (time.ts) and passes values into the pure domain functions.

import type { DeskLock } from '../domain/desk-lock.js'
import type { ReviewState } from '../domain/review.js'

// The working-tree/platform filesystem surface the diff build, content and staging flows
// drive, kept narrow: path resolution, directory probing, working-file reads and the
// temp-file lifecycle of index patching. Implemented by the filesystem outbound adapter and
// carried as the `workspace` facet of GitPort (the git adapter already owns working-tree
// reads beside fileAt), so application code imports no node:fs and the use-case signatures
// stay git-shaped.
export interface WorkspacePort {
	// Symlink-resolved absolute path, or null when the path doesn't resolve (callers fall back).
	readonly realpath: (path: string) => Promise<string | null>
	// True only when the path exists and is a directory; unreadable/missing reads as false.
	readonly isDirectory: (path: string) => Promise<boolean>
	// A file's UTF-8 bytes, or null when it can't be read (vanished, unreadable, directory).
	readonly readFile: (path: string) => Promise<string | null>
	// Seed a unique same-filesystem temp file with contents and hand back its path
	// (staging's `git apply` needs a file argument). Throws AdapterError on failure.
	readonly writeTempFile: (contents: string) => Promise<string>
	// Remove a temp directory tree (best effort - cleanup failures are swallowed).
	readonly removeTempDir: (dir: string) => Promise<void>
}

// The git surface the diff builders, content resolution and staging flows drive.
export interface GitPort {
	// One `git` invocation with the shared quotePath=false wrapper; trimmed stdout.
	readonly run: (args: string[], cwd: string) => Promise<string>
	// One file's contents at a ref (git blob) or from the working tree; by default a
	// missing side degrades to "" (see the git adapter for the `strict` rethrow).
	readonly fileAt: (
		root: string,
		rel: string | undefined,
		ref?: string,
		strict?: boolean,
	) => Promise<string>
	// Per-file new-side blob OIDs harvested from one `git diff --raw` process.
	readonly rawBlobOids: (
		root: string,
		query: { staged?: boolean; base?: string; path?: string },
	) => Promise<Map<string, string>>
	readonly getGitRoot: (cwd: string) => Promise<string>
	readonly getHead: (cwd: string) => Promise<string | null>
	// The branch checked out at cwd ("" when HEAD can't be resolved) - the CLI's default
	// session name comes from it.
	readonly getBranch: (cwd: string) => Promise<string>
	// The repo's tracked files, sorted - the /api/tree listing (a git adapter read).
	readonly projectTree: (root: string) => Promise<string[]>
	// The working-tree filesystem facet (see WorkspacePort) - same adapter object, so the
	// use cases take one capability and the composition roots wire one port.
	readonly workspace: WorkspacePort
}

// The persisted-review store: load the newest saved review for a session, persist
// the live state, and write auxiliary artifacts (the Send result) atomically.
export interface ReviewStorePort {
	readonly loadLatestReview: (
		root: string,
		session: string,
	) => Promise<ReviewState | null>
	readonly persistReview: (state: ReviewState) => Promise<PersistedReview>
	readonly writeFileAtomic: (file: string, contents: string) => Promise<void>
}

// The bookkeeping a persisted file carries about itself: when it was written, and the name it
// was written under (so the next save overwrites the same file).
export type ReviewStamp = { updatedAt: string; persistFile: string }

export type PersistedReview = { file: string; stamp: ReviewStamp }

// The global reviewer preferences (~/.syneva/settings.json): the desk reads them for the
// open-editor command template and serves/writes them for the tab's Settings dialog.
export interface SettingsPort {
	readonly read: () => Promise<Record<string, unknown>>
	readonly write: (settings: unknown) => Promise<void>
}

// Launch the reviewer's configured editor for one repo file. The result codes are the
// desk's editor failure contract: EDITOR_NOT_ALLOWED / BAD_EDITOR_COMMAND are preference
// problems (the tab answers 422), EDITOR_FAILED is a launch failure (500).
export type EditorLaunch =
	| { ok: true }
	| { ok: false; code: string; message: string }

export interface EditorPort {
	// `line` is the raw request value; the adapter normalizes it (absent/non-integer → top).
	readonly open: (
		root: string,
		file: string,
		line: unknown,
	) => Promise<EditorLaunch>
}

// The desk-lock store (~/.syneva/<repo hash>/<session>/desk.lock): the lock a live desk
// writes and the agent subcommands read to find it. A lock whose pid is dead is swept on
// the way out (see the filesystem adapter).
export interface DeskLockPort {
	readonly read: (root: string, session: string) => Promise<DeskLock | null>
	readonly findLive: (root: string) => Promise<DeskLock[]>
	// Best-effort removal of a session's lock file (dead-desk sweep).
	readonly remove: (root: string, session: string) => Promise<void>
}

// The new-version check a desk start runs before binding (an offer may re-exec the CLI).
export interface UpdateCheckPort {
	readonly maybeOfferUpdate: () => Promise<void>
}
