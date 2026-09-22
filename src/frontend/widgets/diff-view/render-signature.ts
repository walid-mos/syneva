import type { ReviewComment, ReviewState } from '@entities/review/model'
import type { Selection } from '@shared/diff-renderer/types'
import type { DiffView } from './diff-key'

// The composer-related store fields the digest reads - a structural view, not the app
// store's facade type.
type ComposerStoreView = {
	composerOpen: boolean
	fileComposerOpen: boolean
	editingCommentId: string | null
	selected: Selection
}

// The identity of a rendered diff OUTCOME: the same file (identity, paths, content), the same
// reviewer decisions, and the same comment threads encode the exact same #diff paint. Pure over
// the store-projected inputs (see renderDiffInstance) - structural on DiffView, no cycle back from
// diff-instance, and Node tests run it without a DOM.
// The file slice is the member set the digest reads, not ReviewFile wholesale.
type SignedFile = {
	path: string
	contentHash: string
	oldPath?: string | null
	newPath?: string | null
}

// Field separator inside a record: not a valid id/side/status value, so records can't collide
// across boundary shifts; the records within one group keep their joined order (the state's
// own insertion order, which the desk preserves between saves).
const FIELD = '\u001f'
const RECORD = '\u0000'
const GROUP = '\u0001'

// Change digest. The id identifies the block (position + identity) and the status is what the
// reviewer decided about it.
type ChangeRecord = {
	id: string
	status: ReviewState['changes'][number]['status']
}

function changeSignature(change: ChangeRecord): string {
	return [change.id, change.status].join(FIELD)
}

// updatedAt covers in-place body edits; ids/status/position cover set membership and thread
// placement. Bodies aren't digested: a hash per body costs more than the rebuild it prevents.
function commentSignature(comment: ReviewComment): string {
	return [
		comment.id,
		comment.status,
		comment.side,
		String(comment.lineNumber),
		comment.updatedAt,
	].join(FIELD)
}

// Digest of everything renderDiffInstance paints. A caller pairs it with diffKey: diffKey owns
// the rendering options (settings, split style, guide), this owns the data - only a full pair
// match proves "the next inst.render() would paint identically to what's mounted".
export function renderSignature(
	file: SignedFile,
	view: DiffView,
	changes: ChangeRecord[],
	{
		comments,
		composer,
	}: {
		comments: ReviewComment[]
		composer: Pick<
			ComposerStoreView,
			| 'composerOpen'
			| 'fileComposerOpen'
			| 'editingCommentId'
			| 'selected'
		>
	},
): string {
	// Opening/replying/editing changes annotations without changing persisted comments. The file
	// composer hangs off the header (file-comments.ts), so its flag flips too. Closed selections
	// and draft keystrokes do not change the mounted editor structure.
	let composerState = ''
	if (composer.composerOpen)
		composerState = JSON.stringify([
			composer.editingCommentId,
			composer.selected,
		])
	else if (composer.fileComposerOpen)
		composerState = JSON.stringify(['file', composer.editingCommentId])
	return [
		file.path,
		file.contentHash,
		file.oldPath ?? '',
		file.newPath ?? '',
		String(view.isPreviewing),
		String(view.isExpandedUnchanged),
		GROUP,
		changes.map(changeSignature).join(RECORD),
		GROUP,
		comments.map(commentSignature).join(RECORD),
		GROUP,
		composerState,
	].join(FIELD)
}
