import {
	currentFileComments,
	currentFileOrNull,
} from '@entities/review/changes'
import { buildComposer } from '@features/manage-comment/composer'

import { diffCtx } from '../context'

import { buildCommentThread } from './comment-thread'

import type { ThreadMeta } from '@entities/review/annotations'

// ── Whole-file comments (the file header's comment thread) ───────────────────
// The desk hosts comments addressed to a file as a whole alongside the line threads: a comment
// icon in the guide bar (guided desks; the file header's own button on unguided ones) toggles a
// composer with the same Ask / Request change intents, and the file's whole-file comments render
// as one thread under the file header (like the unanchored strip, an annotation-family card).
// Thread derivation and the composer toggles live here; the composer lifecycle itself is
// composer.ts's.

// The current file's whole-file comments as one thread (all file comments share the single
// file-level anchor, so there is exactly one). Null when the file has none.
export function fileThreadMeta(): ThreadMeta | null {
	const comments = currentFileComments(
		diffCtx().S.state,
		currentFileOrNull(
			diffCtx().S.state?.files,
			diffCtx().S.preview,
			diffCtx().S.fileIndex,
		),
	)
	if (!comments.length) return null
	const [first] = comments
	return {
		type: 'thread',
		path: first.path,
		side: first.side,
		lineNumber: first.lineNumber,
		status: comments.some(c => c.status === 'open') ? 'open' : 'resolved',
		comments,
		fileLevel: true,
	}
}

// Is the whole-file comment worth surfacing on this desk? A single-file desk (`syneva file
// <path>`) puts every comment on the one file already, so a file-level scope adds nothing -
// the trigger hides there (any existing whole-file threads keep rendering).
export function fileCommentsEnabled(): boolean {
	return diffCtx().S.state?.mode !== 'file'
}

// The icon-only trigger (count badge when the file has open comments). Shared by the file
// header and the markdown strip; the guide bar's twin is static markup (index.html).
export function fileCommentIconButton(): HTMLElement {
	const b = document.createElement('button')
	b.className = 'fc-btn'
	if (diffCtx().S.fileComposerOpen) b.classList.add('active')
	b.setAttribute(
		'data-tip',
		diffCtx().S.fileComposerOpen
			? 'Close file comment (⇧C)'
			: 'Comment on file (⇧C)',
	)
	const icon = `<svg class="ic"><use href="#gly-comment"></use></svg>`
	// Open reviewer comments (agent replies join the thread but don't add objection weight -
	// the badge matches the blockers chip's count).
	const open = currentFileComments(
		diffCtx().S.state,
		currentFileOrNull(
			diffCtx().S.state?.files,
			diffCtx().S.preview,
			diffCtx().S.fileIndex,
		),
	).filter(c => c.status === 'open' && c.role !== 'agent').length
	b.innerHTML = open ? `${icon}<span class="fc-count">${open}</span>` : icon
	b.addEventListener('click', () => diffCtx().S.toggleFileComposer?.())
	return b
}

// A new-comment composer card (as opposed to a reply, which the open thread hosts itself) -
// only when the file composer is up, nothing is being edited, and no open thread exists to
// host it. Mirrors the line composer's annotations() rule.
function standaloneComposer(): HTMLElement | null {
	if (!diffCtx().S.fileComposerOpen || diffCtx().S.editingCommentId)
		return null
	if (fileThreadMeta()?.status === 'open') return null
	const wrap = document.createElement('div')
	wrap.className = 'annotation fc-new'
	wrap.appendChild(buildComposer())
	return wrap
}

// The thread card for one whole-file file-comment group, with the attribute the blockers
// chip's jump targets (.fc-section [data-file-thread]).
function threadBox(thread: ThreadMeta): HTMLElement {
	const box = document.createElement('div')
	box.className = `annotation${thread.status === 'resolved' ? ' resolved' : ''}`
	box.dataset.fileThread = String(thread.lineNumber)
	box.appendChild(buildCommentThread(thread))
	return box
}

// The section under the file header (and on the oversized card) when there is anything to show:
// optional trigger bar, the file's whole-file thread, a standalone composer when one is open.
export function fileCommentSection(): HTMLElement | null {
	if (!fileThreadMeta() && !standaloneComposer()) return null
	return buildSection(null)
}

// The markdown rendered view replaces the whole diff pane, so it carries its own trigger plus
// the same thread/composer surfaces. The guide bar remains visible above it, so its button is
// duplicated by design (GitHub's per-file comment buttons work the same way).
// Always renders while whole-file comments are enabled - the trigger must exist even with no
// comments yet. On a single-file desk a whole-file scope means nothing, so the strip shows
// itself only when data exists (no trigger).
export function markdownFileCommentStrip(): HTMLElement | null {
	if (!fileCommentsEnabled()) {
		if (!fileThreadMeta()) return null
		return buildSection(null)
	}
	return buildSection(markdownBar())
}

// Head row for the markdown strip: trigger + the file it addresses (the strip sits alone at
// the top of the rendered content, where a bare icon would have no owner to lean on).
function markdownBar(): HTMLElement {
	const bar = document.createElement('div')
	bar.className = 'fc-bar'
	bar.appendChild(fileCommentIconButton())
	const label = document.createElement('span')
	label.className = 'fc-label'
	label.textContent = `Comment on ${
		currentFileOrNull(
			diffCtx().S.state?.files,
			diffCtx().S.preview,
			diffCtx().S.fileIndex,
		)
			?.path.split('/')
			.pop() ?? 'this file'
	}`
	bar.appendChild(label)
	return bar
}

function buildSection(bar: HTMLElement | null): HTMLElement {
	const section = document.createElement('div')
	section.className = 'fc-section'
	if (bar) section.appendChild(bar)
	const thread = fileThreadMeta()
	if (thread) section.appendChild(threadBox(thread))
	const composer = standaloneComposer()
	if (composer) section.appendChild(composer)
	return section
}
