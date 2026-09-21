// Shared review wire records - the records both the desk's persisted review and
// the browser/agent DTOs carry over the wire. A neutral dependency sink like the
// rest of src/contracts: no backend/frontend imports, no platform API.
//
// Domain ownership: the backend's persisted/derived shapes (ReviewState, Diff*,
// ReviewFile) live in src/backend/domain/review.ts, which mirrors the records
// below structurally (domain may not import contracts). Keep the mirrored shapes
// in structural sync when editing either side.

export type ReviewMode = 'repo' | 'file' | 'pr'

export type ReviewComment = {
	id: string
	path: string
	side: 'additions' | 'deletions'
	lineNumber: number
	endLine?: number
	body: string
	createdAt: string
	updatedAt: string
	status: 'open' | 'resolved' | 'stale'
	// "action" = a change request (goes back to the agent on Send); "question" = a
	// just-in-time question answered live via the await stream; "note" = plain note.
	intent?: 'note' | 'action' | 'question'
	// "user" comments are the reviewer's; "agent" comments are replies posted
	// back by the coding agent via `syneva comment` between sessions.
	role?: 'user' | 'agent'
	// Exact text of the anchored line at creation time. Lets reload re-anchor the thread
	// when the agent's edits shift the line (see reanchorComments).
	anchorText?: string
	// Set by re-anchoring when the anchor can't be recovered (line gone or ambiguous);
	// the desk shows these threads in a file-level strip instead of on a diff row.
	unanchored?: boolean
	// "file" = a whole-file comment (addressed to the file, not a diff line; the desk hosts it
	// from the file header). File comments carry lineNumber 0 and side 'additions' as placeholders
	// - side/line are meaningless there, real lines are 1-based, so no line-keyed grouping can ever
	// match them. Omitted on line comments; every construction derives it from lineNumber
	// (commentAnchor in backend/domain/comments.ts), so the field can't disagree with lineNumber 0.
	anchor?: 'file'
}

export type ChangeState = {
	id: string
	path: string
	hunkIndex: number
	// Index of this change block within its hunk's content segments.
	changeIndex?: number
	side: 'additions' | 'deletions'
	lineNumber: number
	// Last line of the change block (multi-line blocks); anchors the Undo/Keep annotation.
	endLine?: number
	title: string
	stableKey?: string
	status: 'pending' | 'accepted' | 'rejected'
	// Whether accepting this change stages it to the git index. True only for
	// uncommitted modifications of tracked files (repo mode; file mode when the
	// file is tracked + changed). PR mode and untracked files are verdict-only.
	stageable?: boolean
	// Hash of the change block's content, computed when the diff is parsed.
	contentHash?: string
	// contentHash captured at the moment a decision was made; lets a reload
	// detect that the underlying code changed and the prior decision is stale.
	reviewedHash?: string
	// Where this block sits in the RENDERED (decision-replayed) diff - @pierre renumbers
	// lines on every resolution, so these drift from lineNumber/endLine (the raw file
	// lines, which stay canonical). Derived per render (syncDisplayAnchors), never trusted
	// from persisted state.
	displayLineNumber?: number
	displayEndLine?: number
}

// An explicit, durable record of a user's accept/reject on a change block, keyed
// by stable identity (`path:stableKey`). This - not git staging - is the source
// of truth for decisions, so a decision survives a reload even when accepting it
// staged the hunk out of the working-tree diff (where it would otherwise vanish).
export type Decision = {
	key: string // `${path}:${stableKey}`
	status: 'accepted' | 'rejected'
	// contentHash the decision was made against; lets reconciliation drop a decision
	// as stale if the agent rewrote that block since it was reviewed.
	reviewedHash?: string
	path: string
	lineNumber: number
	side: 'additions' | 'deletions'
	title: string
}

// A per-file entry in the agent-supplied grouping. `order` drives Next/Prev (general →
// specific); `category` is the Walkthrough section the file is listed under (e.g.
// Config/Core/Wiring - semantic, distinct from the folder). That is the whole entry: the desk is
// the review surface, so it carries no agent-written prose. Both fields are normalized on attach
// (validateGuide in backend/domain/guide.ts defaults them from the array position / "Changes"),
// so this is the shape the desk stores and reads - not the shape an agent has to write.
export type GuideFile = {
	path: string
	order: number
	category: string
}

// The grouping the coding agent attaches with --guide: which files to review, in which order,
// under which headings. Absent on a review state → the desk lists files in diff order and every
// guide surface stays off. A guide is a grouping only - order and labels; it holds no prose.
export type Guide = {
	files: GuideFile[]
	// baseDiffHash the grouping was generated against - set on attach; the desk notes the
	// grouping may be out of date once a reload advances the diff past it.
	baseDiffHash?: string
}
