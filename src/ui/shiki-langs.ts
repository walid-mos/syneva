// The single curated Shiki language set, deep-imported so only these grammars are bundled (shiki's
// full bundle statically references ~180 grammars + a 607 KB oniguruma wasm). Consumed by BOTH
// markdown.ts (comment/file fenced code) and shiki-shim.ts (the diff view via @pierre/diffs) - one
// language set styles both surfaces. Split into the two cohesive groups below so each module stays
// under the import-count cap while the deep imports (and therefore the bundled set) stay exact.
//
// Languages outside this set degrade to plain text: markdown-it falls back via fallbackLanguage,
// and the shim's bundledLanguages Proxy hands @pierre/diffs an empty-patterns grammar. Adding a
// language here is the one place to grow coverage - keep it lean, the build gates on bundle size.
import { SYSTEM_LANGS } from './shiki-langs-systems'
import { WEB_LANGS } from './shiki-langs-web'

export const CURATED_LANGS = [...WEB_LANGS, ...SYSTEM_LANGS]
