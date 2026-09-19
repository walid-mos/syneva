import { SYSTEM_LANGS } from './shiki-langs-systems'
import { WEB_LANGS } from './shiki-langs-web'

// The single curated Shiki language set, consumed by BOTH markdown.ts (comment/file fenced code)
// and shiki-shim.ts (the diff view via @pierre/diffs) - one language set styles both surfaces.
//
// Every grammar is a LAZY loader: the static import of 25 grammars made one 2.5 MB chunk that both
// the UI graph and every token worker pulled in (the pooled workers carry four copies), while the
// diff view needs at most the one or two languages of the file being reviewed. Name + aliases stay
// static because @pierre/diffs resolves a file name to a language by name; the grammar body is
// fetched by the chunk loader only when something asks for that language.
import type { LanguageRegistration } from 'shiki/core'

export type CuratedLanguage = {
	// Canonical grammar name, then the aliases @pierre's file-name lookup may ask for.
	name: string
	aliases?: string[]
	// The grammar module: `default` is shiki's LanguageRegistration[] (the grammar plus its
	// embedded-language dependencies, which is why the array itself is forwarded).
	load: () => Promise<{ default: LanguageRegistration[] }>
}

export const CURATED_LANGS: CuratedLanguage[] = [...WEB_LANGS, ...SYSTEM_LANGS]

// The markdown engine preloads the whole curated set (a comment can fence any language from it),
// so it awaits every loader once at init instead of paying for all of them at import time.
export async function loadCuratedGrammars(): Promise<LanguageRegistration[][]> {
	return Promise.all(
		CURATED_LANGS.map(async language => (await language.load()).default),
	)
}
