// Web/markup grammars of the curated Shiki set (see shiki-langs.ts for the whole set and why it
// is curated at all). Deep-imported from shiki/dist/langs so only these grammars are bundled.
import css from 'shiki/dist/langs/css.mjs'
import html from 'shiki/dist/langs/html.mjs'
import javascript from 'shiki/dist/langs/javascript.mjs'
import json from 'shiki/dist/langs/json.mjs'
import jsx from 'shiki/dist/langs/jsx.mjs'
import scss from 'shiki/dist/langs/scss.mjs'
import tsx from 'shiki/dist/langs/tsx.mjs'
import typescript from 'shiki/dist/langs/typescript.mjs'
import vue from 'shiki/dist/langs/vue.mjs'
import xml from 'shiki/dist/langs/xml.mjs'

export const WEB_LANGS = [
	javascript,
	typescript,
	tsx,
	jsx,
	vue,
	json,
	html,
	xml,
	css,
	scss,
]
