import { currentFile, currentComments } from './changes'
import { buildCommentThread } from './comment-thread'
import { buildComposer, openComposer } from './composer'
import { cur } from './contents'
import { renderMarkdown } from './markdown'
import { S, $ } from './store'

import type { ReviewComment } from './types'

// A markdown-block line has no display/raw split (D.lineMap is null here), so the source
// line is the anchor directly. The composer renders inline via renderMarkdownFile below.
function openComposerAt(lineNumber: number): void {
	S.selected = { side: 'additions', lineNumber }
	openComposer()
}

// A commentable block is any element carrying a source line, except the list
// containers themselves (you comment on the individual <li>, not the whole list).
function isAnchor(el: Element): boolean {
	return (
		el.hasAttribute('data-line') &&
		el.tagName !== 'UL' &&
		el.tagName !== 'OL'
	)
}

// The formatted markdown gets its own child of #diff, so the overlays below have a
// container that survives them (they append/insert siblings around the blocks).
function createMarkdownContainer(): HTMLElement {
	const container = document.createElement('div')
	container.className = 'md-file md'
	$('diff').replaceChildren(container)
	return container
}

// Mark every commentable block, and return them in document order - the overlay below
// resolves a comment's line to the last block starting at or before it.
function markAnchors(container: HTMLElement): HTMLElement[] {
	const anchors = [
		...container.querySelectorAll<HTMLElement>('[data-line]'),
	].filter(isAnchor)
	for (const el of anchors) {
		el.classList.add('md-anchor')
		el.title = 'Click to comment'
	}
	return anchors
}

// Click anywhere on a block to comment on it (ignore text selection, links, and clicks
// inside an existing thread). Delegated so it survives the per-render rebuild.
function attachBlockCommentHandler(container: HTMLElement): void {
	container.addEventListener('click', event => {
		const { target } = event
		if (!(target instanceof Element)) return
		if (target.closest('a, button, input, .md-thread')) return
		if (!window.getSelection()?.isCollapsed) return // user is selecting text
		const el = target.closest<HTMLElement>('[data-line]')
		if (!el || !isAnchor(el)) return // clicked the list container gutter, not an item
		openComposerAt(Number(el.dataset.line))
	})
}

// A comment's own block: inside the <li> for list items (indented under the item), after
// the block otherwise - and appended to the end when its line has no block (a stale
// anchor, e.g. the block was edited away while the comment stayed).
function placeAtLine(
	container: HTMLElement,
	anchors: HTMLElement[],
	lineNumber: number,
	node: HTMLElement,
): void {
	const el = anchorForLine(anchors, lineNumber)
	if (!el) container.appendChild(node)
	else if (el.tagName === 'LI') el.appendChild(node)
	else el.after(node)
}

// Comments grouped by the source line they anchor to, each thread oldest-first.
function groupCommentsByLine(
	comments: ReviewComment[],
): Map<number, ReviewComment[]> {
	const byLine = new Map<number, ReviewComment[]>()
	for (const c of comments) {
		const thread = byLine.get(c.lineNumber)
		if (thread) thread.push(c)
		else byLine.set(c.lineNumber, [c])
	}
	for (const thread of byLine.values())
		thread.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
	return byLine
}

// Existing comment threads, overlaid at each comment's source line.
function overlayThreads(
	container: HTMLElement,
	anchors: HTMLElement[],
	threadsByLine: Map<number, ReviewComment[]>,
	path: string,
): void {
	for (const [lineNumber, comments] of threadsByLine) {
		const thread = document.createElement('div')
		thread.className = 'annotation md-thread'
		thread.appendChild(
			buildCommentThread({
				type: 'thread',
				path,
				side: 'additions',
				lineNumber,
				status: comments.some(c => c.status === 'open')
					? 'open'
					: 'resolved',
				comments,
			}),
		)
		placeAtLine(container, anchors, lineNumber, thread)
	}
}

// A new line comment (no existing thread on that line) opens an inline composer under
// its block; a reply/edit renders inside the thread above via buildCommentThread.
function overlayComposer(
	container: HTMLElement,
	anchors: HTMLElement[],
	threadsByLine: Map<number, ReviewComment[]>,
): void {
	const { composerOpen, editingCommentId, selected } = S
	if (
		!composerOpen ||
		editingCommentId ||
		threadsByLine.has(selected.lineNumber)
	)
		return
	const card = document.createElement('div')
	card.className = 'annotation md-thread composer-annotation'
	card.appendChild(buildComposer())
	placeAtLine(container, anchors, selected.lineNumber, card)
}

// Render the current markdown file as formatted HTML in #diff, with click-to-comment on
// each block and existing comment threads overlaid at their source line. Replaces the
// @pierre/diffs view; comments are still plain line-anchored ReviewComments.
export function renderMarkdownFile(): void {
	const { path } = currentFile()
	const container = createMarkdownContainer()
	// Contents come from the per-file fetch (render() awaits it before this runs); `cur` holds
	// the current file's new-side bytes.
	container.innerHTML = renderMarkdown(cur.newContents)
	const anchors = markAnchors(container)
	attachBlockCommentHandler(container)
	const threadsByLine = groupCommentsByLine(currentComments())
	overlayThreads(container, anchors, threadsByLine, path)
	overlayComposer(container, anchors, threadsByLine)
}

// The anchor whose data-line is the largest value <= line (the block the comment sits in).
function anchorForLine(
	anchors: HTMLElement[],
	line: number,
): HTMLElement | null {
	let best: HTMLElement | null = null
	let bestLine = -1
	for (const el of anchors) {
		const { line: anchorLine } = el.dataset
		const startLine = Number(anchorLine)
		if (startLine > line || startLine <= bestLine) continue
		best = el
		bestLine = startLine
	}
	return best ?? anchors.at(0) ?? null
}
