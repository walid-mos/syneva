import { render } from './render'
import { esc, S, toast } from './store'

import type * as MarkdownEngine from './markdown-engine'
import type { ReviewComment } from './types'

// Loading a diff without prose must not initialize a second highlighter on the main thread.
// The synchronous rendering seam keeps escaped text usable while the optional island loads.
let engine: typeof MarkdownEngine | undefined
let loading: Promise<void> | undefined
let themeName = ''
export let markdownRevision = 0

function loadMarkdown(): void {
	loading ??= initializeMarkdown()
}

async function initializeMarkdown(): Promise<void> {
	try {
		const module = await import('./markdown-engine')
		await module.initializeMarkdown(themeName || S.settings.theme)
		module.setMarkdownTheme(themeName || S.settings.theme)
		engine = module
		markdownRevision++
		await render()
	} catch {
		loading = undefined
		toast('Markdown rendering could not load. Reopen the file to retry.')
	}
}

export function setMarkdownTheme(name: string): void {
	themeName = name
	engine?.setMarkdownTheme(name)
}

export function renderMarkdown(text: string): string {
	if (engine) return engine.renderMarkdown(text)
	loadMarkdown()
	return `<p>${esc(text)}</p>`
}

export function renderMarkdownInline(text: string): string {
	if (engine) return engine.renderMarkdownInline(text)
	loadMarkdown()
	return esc(text)
}

export function renderCommentBody(comment: ReviewComment): string {
	if (engine) return engine.renderCommentBody(comment)
	loadMarkdown()
	return `<p>${esc(comment.body)}</p>`
}
