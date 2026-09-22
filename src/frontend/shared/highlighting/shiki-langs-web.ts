// Web/markup grammars of the curated Shiki set (see shiki-langs.ts for the whole set, why it is
// curated at all, and why every grammar is a lazy loader). Name + aliases are pinned to each
// grammar's own metadata by shiki-langs.test.ts.
import type { CuratedLanguage } from '@shared/highlighting/shiki-langs'

export const WEB_LANGS: CuratedLanguage[] = [
	{
		name: 'javascript',
		aliases: ['js', 'cjs', 'mjs'],
		load: () => import('shiki/dist/langs/javascript.mjs'),
	},
	{
		name: 'typescript',
		aliases: ['ts', 'cts', 'mts'],
		load: () => import('shiki/dist/langs/typescript.mjs'),
	},
	{ name: 'tsx', load: () => import('shiki/dist/langs/tsx.mjs') },
	{ name: 'jsx', load: () => import('shiki/dist/langs/jsx.mjs') },
	{ name: 'vue', load: () => import('shiki/dist/langs/vue.mjs') },
	{ name: 'json', load: () => import('shiki/dist/langs/json.mjs') },
	{ name: 'html', load: () => import('shiki/dist/langs/html.mjs') },
	{ name: 'xml', load: () => import('shiki/dist/langs/xml.mjs') },
	{ name: 'css', load: () => import('shiki/dist/langs/css.mjs') },
	{ name: 'scss', load: () => import('shiki/dist/langs/scss.mjs') },
]
