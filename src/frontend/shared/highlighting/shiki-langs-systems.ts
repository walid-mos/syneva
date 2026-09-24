// Systems, data and prose grammars of the curated Shiki set (see shiki-langs.ts for the whole set,
// why it is curated at all, and why every grammar is a lazy loader). Name + aliases are pinned to
// each grammar's own metadata.
import type { CuratedLanguage } from '@shared/highlighting/shiki-langs'

export const SYSTEM_LANGS: CuratedLanguage[] = [
	{
		name: 'python',
		aliases: ['py'],
		load: () => import('shiki/dist/langs/python.mjs'),
	},
	{ name: 'go', load: () => import('shiki/dist/langs/go.mjs') },
	{
		name: 'rust',
		aliases: ['rs'],
		load: () => import('shiki/dist/langs/rust.mjs'),
	},
	{ name: 'c', load: () => import('shiki/dist/langs/c.mjs') },
	{
		name: 'cpp',
		aliases: ['c++'],
		load: () => import('shiki/dist/langs/cpp.mjs'),
	},
	{ name: 'java', load: () => import('shiki/dist/langs/java.mjs') },
	{
		name: 'shellscript',
		aliases: ['bash', 'sh', 'shell', 'zsh'],
		load: () => import('shiki/dist/langs/bash.mjs'),
	},
	{ name: 'sql', load: () => import('shiki/dist/langs/sql.mjs') },
	{
		name: 'yaml',
		aliases: ['yml'],
		load: () => import('shiki/dist/langs/yaml.mjs'),
	},
	{
		name: 'markdown',
		aliases: ['md'],
		load: () => import('shiki/dist/langs/markdown.mjs'),
	},
	{ name: 'diff', load: () => import('shiki/dist/langs/diff.mjs') },
	{ name: 'toml', load: () => import('shiki/dist/langs/toml.mjs') },
	{
		name: 'ruby',
		aliases: ['rb'],
		load: () => import('shiki/dist/langs/ruby.mjs'),
	},
	{ name: 'php', load: () => import('shiki/dist/langs/php.mjs') },
	{
		name: 'docker',
		aliases: ['dockerfile'],
		load: () => import('shiki/dist/langs/dockerfile.mjs'),
	},
]
