import { changeAnnotations } from './change-annotations'
import {
	currentComments,
	currentChanges,
	currentFile,
	isFileComment,
	toDisplayLine,
	fromDisplayLine,
} from './changes'
import { buildCommentThread } from './comment-thread'
import { buildComposer } from './composer'
import { acceptChange } from './decisions'
import { S, requireState } from './store'
import { isUnanchored } from './unanchored'

import type {
	AnnotationInput,
	AnnotationMeta,
	ChangeMeta,
	ChangeState,
	ReviewComment,
	ReviewState,
	ThreadMeta,
} from './types'

type ReviewFile = ReviewState['files'][number]

// Comment groups keyed `side:rawLine`, each group oldest-first - the order the conversation
// happened in, which is the order the thread renders. Whole-file comments are excluded: they
// anchor to the file header (file-comments.ts), not a rendered line.
function commentGroups(): Map<string, ReviewComment[]> {
	const groups = new Map<string, ReviewComment[]>()
	for (const c of currentComments()) {
		if (isFileComment(c)) continue
		const key = `${c.side}:${c.lineNumber}`
		const group = groups.get(key)
		if (group) group.push(c)
		else groups.set(key, [c])
	}
	for (const group of groups.values())
		group.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
	return groups
}

// Open threads whose anchor is gone render in the strip above the diff instead (an annotation at a
// non-existent line would silently never attach).
function isUnanchoredGroup(group: ReviewComment[], file: ReviewFile): boolean {
	return (
		group.some(c => c.status === 'open') &&
		group.some(c => isUnanchored(c, file))
	)
}

type ThreadAnnotations = {
	annotations: AnnotationInput[]
	/** the ids of changes an open thread already covers (see changeAnnotations) */
	coveredChangeIds: Set<string>
}

function threadAnnotations(
	groups: Map<string, ReviewComment[]>,
	file: ReviewFile,
): ThreadAnnotations {
	const threads: AnnotationInput[] = []
	const coveredChangeIds = new Set<string>()
	const changes = currentChanges()
	for (const group of groups.values()) {
		const [first] = group
		if (isUnanchoredGroup(group, file)) continue
		const change = changes.find(
			ch =>
				ch.status === 'pending' &&
				ch.side === first.side &&
				ch.lineNumber === first.lineNumber,
		)
		if (change) coveredChangeIds.add(change.id)
		// The annotation goes to @pierre in DISPLAY coordinates (it matches rendered gutter
		// numbers); the metadata keeps the raw line so thread actions filter comments correctly.
		threads.push({
			side: first.side,
			lineNumber: toDisplayLine(first.side, first.lineNumber),
			metadata: {
				type: 'thread',
				path: first.path,
				side: first.side,
				lineNumber: first.lineNumber,
				status: group.some(c => c.status === 'open')
					? 'open'
					: 'resolved',
				comments: group,
				changeId: change?.id,
			},
		})
	}
	return { annotations: threads, coveredChangeIds }
}

// A new line comment (not a reply, not an edit) opens as its own composer annotation under the
// selected line. Suppressed only when an OPEN thread already sits there - that thread hosts the
// reply composer itself (in the diff, or in the unanchored strip). A resolved thread renders as a
// collapsed summary and never hosts a composer, so the new comment still needs its own row.
// S.selected is display space; groups are keyed raw.
function composerAnnotations(
	file: ReviewFile,
	groups: Map<string, ReviewComment[]>,
): AnnotationInput[] {
	if (!S.composerOpen || S.editingCommentId) return []
	const rawLine = fromDisplayLine(S.selected.side, S.selected.lineNumber)
	const group = groups.get(`${S.selected.side}:${rawLine}`)
	if (group?.some(c => c.status === 'open')) return []
	return [
		{
			side: S.selected.side,
			lineNumber: S.selected.lineNumber,
			metadata: {
				type: 'composer',
				side: S.selected.side,
				lineNumber: S.selected.lineNumber,
				path: file.path,
			},
		},
	]
}

// When a thread and a change land on the same display line, the decision bar must sit immediately
// under the hunk with the thread below it - annotations render in array order, so changes go
// first, the composer last.
export function annotations(): AnnotationInput[] {
	const file = currentFile()
	const groups = commentGroups()
	const threads = threadAnnotations(groups, file)
	return [
		...changeAnnotations(threads.coveredChangeIds),
		...threads.annotations,
		...composerAnnotations(file, groups),
	]
}

// The change a thread hangs off, for the verdict bar under it: its own change for a change
// annotation, its changeId for a thread, null when neither resolves.
function changeFor(c: ThreadMeta | ChangeMeta): ChangeState | null {
	const { changes } = requireState()
	if (c.type === 'change') return changes.find(x => x.id === c.id) ?? null
	if (!c.changeId) return null
	return changes.find(x => x.id === c.changeId) ?? null
}

const VERDICT_BUTTONS = `<button class="reject">Undo <kbd>⇧N</kbd></button><button class="accept">Keep <kbd>⇧Y</kbd></button>`

// The verdict bar under a change or a thread: the two decision buttons, wired by wireVerdict below.
function verdictBar(): HTMLElement {
	const bar = document.createElement('div')
	bar.className = 'change-actions'
	bar.innerHTML = VERDICT_BUTTONS
	return bar
}

// `a` is @pierre/diffs' annotation callback argument (loose by contract); the
// metadata we tucked into it is our own typed AnnotationMeta.
export function renderAnnotation(a: { metadata: AnnotationMeta }): HTMLElement {
	const c = a.metadata
	// A new-comment composer injected under the selected line (reply/edit render inside a
	// thread instead - see buildCommentThread).
	if (c.type === 'composer') {
		const el = document.createElement('div')
		el.className = 'annotation composer-annotation'
		el.appendChild(buildComposer())
		return el
	}
	const change = changeFor(c)
	const el = document.createElement('div')
	el.className = `annotation ${c.type === 'thread' && c.status === 'resolved' ? 'resolved' : ''}`
	if (c.type === 'change') {
		el.appendChild(verdictBar())
	} else {
		el.appendChild(buildCommentThread(c))
		if (change) el.appendChild(verdictBar())
	}
	wireVerdict(el, change)
	return el
}

// The verdict bar's two buttons act on the change the annotation sits on, when there is one.
function wireVerdict(el: HTMLElement, change: ChangeState | null): void {
	const accept = el.querySelector<HTMLButtonElement>('.accept')
	const reject = el.querySelector<HTMLButtonElement>('.reject')
	if (!change || !accept || !reject) return
	accept.addEventListener(
		'click',
		() => void acceptChange(change.id, 'accepted'),
	)
	reject.addEventListener(
		'click',
		() => void acceptChange(change.id, 'rejected'),
	)
}
