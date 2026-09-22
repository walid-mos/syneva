import { esc } from '@shared/lib/esc'

import { markdownRuntime } from './runtime-config'

import type * as MarkdownEngine from './engine'
import type { MarkdownComment } from './engine'

// The markdown loader is stateless shared infrastructure: it lazily brings up the engine
// (shiki + markdown-it), but it reads the live theme, repaints through the render funnel,
// and toasts on failure - runtime behaviour composed in app/main.ts via
// configureMarkdownRuntime() (runtime-config.ts, also the engine's read seam).

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
		const module = await import('@shared/markdown/engine')
		const theme = themeName || markdownRuntime().getTheme()
		await module.initializeMarkdown(theme)
		module.setMarkdownTheme(theme)
		engine = module
		markdownRevision++
		markdownRuntime().onLoaded()
	} catch {
		loading = undefined
		markdownRuntime().onLoadError()
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

// The rendered FILE view: like renderMarkdown but raw HTML passes (sanitized) and the file's
// relative image srcs rewrite to /api/blob - see engine.ts.
export function renderFileMarkdown(text: string): string {
	if (engine) return engine.renderFileMarkdown(text)
	loadMarkdown()
	return `<p>${esc(text)}</p>`
}

export function renderMarkdownInline(text: string): string {
	if (engine) return engine.renderMarkdownInline(text)
	loadMarkdown()
	return esc(text)
}

export function renderCommentBody(comment: MarkdownComment): string {
	if (engine) return engine.renderCommentBody(comment)
	loadMarkdown()
	return `<p>${esc(comment.body)}</p>`
}
