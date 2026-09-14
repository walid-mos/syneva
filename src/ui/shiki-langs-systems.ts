// Systems, data and prose grammars of the curated Shiki set (see shiki-langs.ts for the whole set
// and why it is curated at all). Deep-imported from shiki/dist/langs so only these grammars bundle.
import bash from 'shiki/dist/langs/bash.mjs'
import c from 'shiki/dist/langs/c.mjs'
import cpp from 'shiki/dist/langs/cpp.mjs'
import diff from 'shiki/dist/langs/diff.mjs'
import dockerfile from 'shiki/dist/langs/dockerfile.mjs'
import go from 'shiki/dist/langs/go.mjs'
import java from 'shiki/dist/langs/java.mjs'
import markdownLang from 'shiki/dist/langs/markdown.mjs'
import php from 'shiki/dist/langs/php.mjs'
import python from 'shiki/dist/langs/python.mjs'
import ruby from 'shiki/dist/langs/ruby.mjs'
import rust from 'shiki/dist/langs/rust.mjs'
import sql from 'shiki/dist/langs/sql.mjs'
import toml from 'shiki/dist/langs/toml.mjs'
import yaml from 'shiki/dist/langs/yaml.mjs'

export const SYSTEM_LANGS = [
	python,
	go,
	rust,
	c,
	cpp,
	java,
	bash,
	sql,
	yaml,
	markdownLang,
	diff,
	toml,
	ruby,
	php,
	dockerfile,
]
