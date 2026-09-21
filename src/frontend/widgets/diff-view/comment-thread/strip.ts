import { unanchoredThreads } from '../unanchored'

import { buildCommentThread } from './comment-thread'

// The strip of unanchored threads, shown as the diff's first row under the file header so
// they stay actionable (they block approval until resolved). Built per render alongside
// the whole-file comment section (file-comments.ts) - the two header strips.
export function unanchoredStrip(): HTMLElement | null {
	const orphans = unanchoredThreads()
	if (!orphans.length) return null
	const strip = document.createElement('div')
	strip.className = 'unanchored-strip'
	const head = document.createElement('div')
	head.className = 'unanchored-head'
	const noun = orphans.length === 1 ? 'thread' : 'threads'
	const pronoun = orphans.length === 1 ? 'its' : 'their'
	head.textContent = `${orphans.length} comment ${noun} lost ${pronoun} place in this diff - resolve or reply here`
	strip.appendChild(head)
	for (const thread of orphans) {
		// Reuse the annotation thread styling (it's all scoped under .annotation).
		const box = document.createElement('div')
		box.className = 'annotation'
		box.dataset.thread = `${thread.side}:${thread.lineNumber}` // blockers jump target
		box.appendChild(buildCommentThread(thread))
		strip.appendChild(box)
	}
	return strip
}
