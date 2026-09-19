import { fromHighlighter } from '@shikijs/markdown-it/core'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
// markdown-it-task-lists ships no types and has no @types package.
// @ts-expect-error: could not find a declaration file for module 'markdown-it-task-lists'
import taskLists from 'markdown-it-task-lists'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// The curated Shiki theme + language set is shared with the diff view (@pierre/diffs, via
// shiki-shim.ts) so one language set styles both surfaces - see shiki-langs.ts / shiki-themes.ts. The JS regex
// engine (below) avoids an oniguruma wasm, and the theme names match the settings picker.
import { loadCuratedGrammars } from './shiki-langs'
import { CURATED_THEMES as THEMES } from './shiki-themes'
import { esc } from './store'

import type { HighlighterCore } from 'shiki/core'
import type { ReviewComment } from './types'

// One markdown renderer for both comment bodies (#17) and markdown files (#21).
// markdown-it gives exact per-block source lines (token.map) - see sourceLine below -
// which is why we use it over comark; html:false drops raw HTML at the source, and
// DOMPurify is the final gate before anything is innerHTML'd (incl. agent-authored).

// buildMd builds one renderer per use site: `html:false` for guide prose and comment bodies
// (raw HTML stays printed as literal text - agent-authored prose never becomes DOM), and
// `html:true` for the FILE view (markdownFileCommentStrip's sibling - a reviewed file may
// legitimately carry HTML like the GitHub-README <div>/<img> wrappers), which then passes
// through the same DOMPurify gate before mounting.
let md: MarkdownIt | null = null
let mdFile: MarkdownIt | null = null
// A second renderer for comment bodies with `breaks: true`, so a single newline a reviewer types
// renders as a line break (people write comments as chat, not markdown source). File/guide
// markdown keeps the standard soft-break behavior via `md`, so hard-wrapped prose isn't shredded.
let mdComment: MarkdownIt | null = null
let hl: HighlighterCore | null = null
// Comment bodies re-render on every poll tick, and each edit mints a fresh id:updatedAt key -
// so the cache would grow without bound (an orphaned entry per edit) if left uncapped. An LRU
// keeps it bounded like the other UI caches (contents.ts, render.ts both cap at 30).
const COMMENT_CACHE_CAP = 30
const cache = new Map<string, string>()

// Stamp each commentable block-open token with its 1-based source line (1-based
// matches @pierre/diffs' additions-side numbers). Top-level blocks AND list items,
// so a comment can target an individual list item rather than the whole list.
function sourceLine(mdi: MarkdownIt): void {
	mdi.core.ruler.push('source_line', state => {
		for (const t of state.tokens)
			if (t.map && (t.level === 0 || t.type === 'list_item_open'))
				t.attrSet('data-line', String(t.map[0] + 1))
		return true
	})
}

// Shiki's highlighter loads async (wasm + grammars); markdown-it render is sync once
// ready. Until then renderMarkdown returns an escaped-text fallback; on ready we
// repaint once so any fallbacks upgrade to rendered markdown.
// An options object over the two orthogonal renderer flavors (the linter caps boolean params):
// `isBreakOnNewline` reads comments as chat; `canCarryRawHtml` lets a reviewed file carry raw
// HTML (sanitized below). Guide/file markdown keeps one instance per flavor, shared.
type MarkdownFlavor = {
	isBreakOnNewline?: boolean
	canCarryRawHtml?: boolean
}

function buildMd(
	highlighter: HighlighterCore,
	theme: string,
	flavor: MarkdownFlavor = {},
): MarkdownIt {
	const renderer = new MarkdownIt({
		html: flavor.canCarryRawHtml ?? false,
		linkify: true,
		breaks: flavor.isBreakOnNewline ?? false,
	})
		.use(footnote)
		.use(taskLists, { label: true })
		.use(fromHighlighter(highlighter, { theme }))
		.use(sourceLine)
	const { highlight } = renderer.options
	if (highlight) {
		renderer.options.highlight = withPlainTextFallback(
			highlight,
			highlighter.getLoadedLanguages(),
		)
	}
	return renderer
}

// shiki's special `text` language is the one value that renders an unknown fence as plain text, and
// markdown-it-shiki's `fallbackLanguage` option is typed as a bundled language name - a union that
// omits it (shiki's own default for that option is 'text'). Substitute it at the integration's
// highlight seam instead, so no fence can reach the highlighter's throw-on-unknown path. Same
// substitution, same `language-text` class, and the fence's meta attributes pass through untouched.
const PLAIN_TEXT_LANGUAGE = 'text'
function withPlainTextFallback(
	highlight: NonNullable<MarkdownIt['options']['highlight']>,
	loadedLanguages: string[],
): MarkdownIt['options']['highlight'] {
	return (code, lang, attrs) =>
		highlight(
			code,
			loadedLanguages.includes(lang) ? lang : PLAIN_TEXT_LANGUAGE,
			attrs,
		)
}

// Diff-only themes (e.g. pierre-dark) aren't Shiki bundles → render comment code in the
// GitHub theme matching the chrome appearance (applyAppearance sets <html data-theme>).
function resolveTheme(want: string): string {
	if (want in THEMES) return want
	return document.documentElement.dataset.theme === 'light'
		? 'github-light'
		: 'github-dark'
}

// All curated themes preload into one highlighter, so switching is instant.
export async function initializeMarkdown(themeName: string): Promise<void> {
	const highlighter = await createHighlighterCore({
		themes: Object.values(THEMES),
		langs: await loadCuratedGrammars(),
		engine: createJavaScriptRegexEngine(),
	})
	hl = highlighter
	const theme = resolveTheme(themeName)
	md = buildMd(highlighter, theme)
	mdFile = buildMd(highlighter, theme, { canCarryRawHtml: true })
	mdComment = buildMd(highlighter, theme, { isBreakOnNewline: true })
}

// Switch the comment-code theme (settings) - rebuild the renderer + drop the cache;
// the caller re-renders. @pierre/diffs handles the diff side with the same theme name.
export function setMarkdownTheme(name: string): void {
	if (!hl) return
	const theme = resolveTheme(name)
	md = buildMd(hl, theme)
	mdFile = buildMd(hl, theme, { canCarryRawHtml: true })
	mdComment = buildMd(hl, theme, { isBreakOnNewline: true })
	cache.clear()
}

// Synchronous once the highlighter is ready.
export function renderMarkdown(text: string): string {
	if (!md) return `<p>${esc(text)}</p>`
	return DOMPurify.sanitize(md.render(text || ''))
}

// The rendered FILE view: raw HTML (GitHub README wrappers, badges) comes through and passes
// the same DOMPurify gate, and the file's own relative image srcs rewrite to /api/blob so its
// assets render. Absolute/external sources pass untouched.
export function renderFileMarkdown(text: string): string {
	if (!mdFile) return `<p>${esc(text)}</p>`
	return rewriteRepoImages(DOMPurify.sanitize(mdFile.render(text || '')))
}

// An img src into a repo-relative file (md or raw HTML) served by the desk's blob route.
// Fragments are meaningless on a binary asset, so they are dropped; absolute, protocol-relative,
// external and data sources pass through.
const NON_REPO_SRC = /^(https?:|data:|blob:|\/)/i
function repoImageUrl(src: string): string {
	const raw = src.trim()
	if (!raw || NON_REPO_SRC.test(raw)) return raw
	return `/api/blob?path=${encodeURIComponent(raw.split('#')[0])}`
}

function rewriteRepoImages(html: string): string {
	if (!html.includes('<img')) return html
	const doc = new DOMParser().parseFromString(html, 'text/html')
	for (const img of doc.querySelectorAll('img[src]')) {
		img.setAttribute('src', repoImageUrl(img.getAttribute('src') ?? ''))
	}
	return doc.body.innerHTML
}

// One-line markdown (guide file summaries): inline rules only, no <p> wrapper. Block-only
// syntax degrades gracefully to its inline text - guide summaries are spec'd as one-liners.
export function renderMarkdownInline(text: string): string {
	if (!md) return esc(text)
	return DOMPurify.sanitize(md.renderInline(text || ''))
}

// Comment body → sanitized HTML, cached by id+updatedAt (so an edit re-renders).
export function renderCommentBody(c: ReviewComment): string {
	const key = `${c.id}:${c.updatedAt}`
	const cached = cache.get(key)
	if (cached) {
		cache.delete(key) // re-insert → most-recently-used
		cache.set(key, cached)
		return cached
	}
	if (!mdComment) return `<p>${esc(c.body)}</p>` // not ready yet - don't cache the fallback
	const html = DOMPurify.sanitize(mdComment.render(c.body || ''))
	cache.set(key, html)
	while (cache.size > COMMENT_CACHE_CAP) {
		const oldest = cache.keys().next()
		if (oldest.done) break
		cache.delete(oldest.value)
	}
	return html
}
