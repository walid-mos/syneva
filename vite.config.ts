// The frontend build: one Vite config drives both bundles.
//  - dist/ui.js + hashed chunks under dist/chunks/ (the desk page)
//  - dist/worker.js, a self-contained module worker (tokenization), emitted by
//    the token-worker-build plugin's own sub-build after the main build
// The desk's static server owns those exact paths (see
// src/backend/adapters/inbound/http/assets.ts and routes/static.ts), and
// scripts/bundle-budget.mjs consumes the emitted dist/ui-manifest.json in the
// esbuild-metafile shape it has always used - both contracts are preserved by
// the budget plugin.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { build as viteBuild, defineConfig } from 'vite'

import { checkBundleBudget } from './scripts/bundle-budget.mjs'

import type { Plugin, UserConfig } from 'vite'

const UI_ENTRY = fileURLToPath(
	new URL('./src/frontend/app/main.ts', import.meta.url),
)
const WORKER_ENTRY = fileURLToPath(
	new URL('./src/frontend/worker/diff-token-worker.ts', import.meta.url),
)
const UI_BUNDLE = 'dist/ui.js'
const MANIFEST = 'dist/ui-manifest.json'
// The desk's chunk route serves [\w-]+-[A-Za-z0-9]{8}\.js; rollup's base36
// charset (digits + lowercase letters, 8 chars) stays inside that contract.
const CHUNK_HASH_CHARS = 'base36'
// A regression tripwire (a grammar or wasm leak back into the worker bundle),
// so it sits just above the current size rather than being generous.
const WORKER_SIZE_LIMIT = 900_000

// Frontend layer aliases (same map as tsconfig.json's paths; @contracts sinks to src/contracts).
const frontendAliases = {
	'@app': fileURLToPath(new URL('./src/frontend/app', import.meta.url)),
	'@pages': fileURLToPath(new URL('./src/frontend/pages', import.meta.url)),
	'@widgets': fileURLToPath(
		new URL('./src/frontend/widgets', import.meta.url),
	),
	'@features': fileURLToPath(
		new URL('./src/frontend/features', import.meta.url),
	),
	'@entities': fileURLToPath(
		new URL('./src/frontend/entities', import.meta.url),
	),
	'@shared': fileURLToPath(new URL('./src/frontend/shared', import.meta.url)),
	'@contracts': fileURLToPath(new URL('./src/contracts', import.meta.url)),
}

// @pierre/diffs imports shiki v3's full barrel (`from "shiki"`), which statically
// pulls ~180 grammars + a 607 KB inlined oniguruma wasm. Reroute ONLY @pierre's bare
// `shiki` specifier to a local shim backed by the curated set; Syneva's own deep
// imports keep resolving to the real v4 package. `shiki/wasm` (referenced by
// @pierre's never-taken oniguruma path) resolves to an empty stub.
const shimPath = fileURLToPath(
	new URL(
		'./src/frontend/shared/highlighting/shiki-shim.ts',
		import.meta.url,
	),
)
const fromPierre = (importer: string): boolean =>
	importer.includes('@pierre/diffs')

const makeShikiShimPlugin = (isWorkerGraph: boolean): Plugin => ({
	name: isWorkerGraph ? 'shiki-shim-worker' : 'shiki-shim',
	enforce: 'pre',
	resolveId: {
		order: 'pre',
		handler(source: string, importer?: string): string | null {
			if (importer && fromPierre(importer)) {
				if (source === 'shiki') return shimPath
				if (source === 'shiki/wasm') return '\0shiki-wasm-stub'
			}
			// Only the worker bundles the oniguruma engine import: the worker
			// statically imports `shiki/engine/oniguruma` and only calls it when the
			// pool was configured with `preferredHighlighter: 'shiki-wasm'` - Syneva
			// always pins 'shiki-js'. Stub it so the wasm runtime (wasmoon) can't
			// reach the worker bundle; if the path is ever taken anyway the stub
			// throws loudly rather than rendering silently unhighlighted.
			if (isWorkerGraph && source === 'shiki/engine/oniguruma')
				return '\0shiki-oniguruma-stub'
			return null
		},
	},
	load: {
		order: 'pre',
		handler(id: string): string | undefined {
			if (id === '\0shiki-wasm-stub') return 'export default {};'
			if (isWorkerGraph && id === '\0shiki-oniguruma-stub')
				return 'export function createOnigurumaEngine() { throw new Error("oniguruma wasm engine was stubbed out of syneva\'s worker bundle (preferredHighlighter must be shiki-js)") }'
			return undefined
		},
	},
})

// The token worker never resolves grammars: the pool manager resolves them (see
// shiki-langs.ts's lazy loaders) and ships the RESOLVED data, which the worker only
// hands to loadLanguageSync. So every grammar import whose importer lives under the
// curated highlighting slice (or @pierre) is stubbed out of the worker build - the
// whole set used to ride along as a 2.5 MB worker.js that each of the pool's four
// workers fetched and compiled on every cold load. Touching the stub is a loud
// error: the worker started resolving languages itself.
const languageStubModule =
	'export default new Proxy({}, { get() { throw new Error("a curated grammar module was resolved inside the token worker: grammars must arrive as RESOLVED data from the pool manager (see src/frontend/shared/highlighting/shiki-langs.ts)") } })'
const makeWorkerLanguageStubPlugin = (): Plugin => ({
	name: 'shiki-worker-language-stub',
	enforce: 'pre',
	resolveId: {
		order: 'pre',
		handler(source: string, importer?: string): string | null {
			if (!source.startsWith('shiki/dist/langs/')) return null
			if (
				importer &&
				(importer.includes('/shared/highlighting/') ||
					importer.includes('@pierre/diffs'))
			) {
				return '\0shiki-lang-stub'
			}
			return null
		},
	},
	load: {
		order: 'pre',
		handler(id: string): string | undefined {
			if (id === '\0shiki-lang-stub') return languageStubModule
			return undefined
		},
	},
})

// Common build options: esbuild parity - no sourcemaps, one minified bundle set.
const buildOptions = (overrides: UserConfig['build']): UserConfig['build'] => ({
	// dist also holds the compiled backend (tsc runs first in `pnpm build`).
	emptyOutDir: false,
	target: 'es2022',
	outDir: 'dist',
	sourcemap: false,
	minify: true,
	modulePreload: { polyfill: false },
	...overrides,
})

// Emits dist/ui-manifest.json in the esbuild-metafile shape and enforces both
// budget gates (initial UI closure, total) so the build fails loudly the way
// build-ui.mjs always did.
const budgetPlugin = (): Plugin => ({
	name: 'ui-bundle-budget',
	apply: 'build',
	writeBundle(_options, bundle) {
		const chunks: { fileName: string; code: string; imports: string[] }[] =
			[]
		for (const [fileName, chunk] of Object.entries(bundle)) {
			if (chunk.type !== 'chunk') continue
			chunks.push({ fileName, code: chunk.code, imports: chunk.imports })
		}
		// esbuild metafile keys are cwd-relative ('dist/ui.js', 'dist/chunks/…');
		// Vite's are outDir-relative, and an import path can be recorded relative to
		// the importing chunk's directory - resolve both forms against the real keys.
		const keys = new Set(chunks.map(chunk => `dist/${chunk.fileName}`))
		const resolveKey = (path: string): string => {
			if (keys.has(path)) return path
			const rootRelative = `dist/${path}`
			if (keys.has(rootRelative)) return rootRelative
			const sameDir = `dist/chunks/${path}`
			if (keys.has(sameDir)) return sameDir
			return rootRelative
		}
		const outputs: Record<
			string,
			{
				bytes: number
				imports: { path: string; external: boolean; kind: string }[]
			}
		> = {}
		for (const chunk of chunks) {
			outputs[`dist/${chunk.fileName}`] = {
				bytes: Buffer.byteLength(chunk.code),
				imports: chunk.imports.map(path => ({
					path: resolveKey(path),
					external: false,
					kind: 'import-statement',
				})),
			}
		}
		writeFileSync(MANIFEST, JSON.stringify(outputs))
		checkBundleBudget(outputs, UI_BUNDLE)
	},
})

// The worker size gate, enforced the way build-ui.mjs always did.
const workerGatePlugin = (): Plugin => ({
	name: 'worker-size-gate',
	apply: 'build',
	writeBundle(_options, bundle) {
		for (const chunk of Object.values(bundle)) {
			if (chunk.type !== 'chunk') continue
			const bytes = Buffer.byteLength(chunk.code)
			if (bytes > WORKER_SIZE_LIMIT)
				throw new Error(
					`${chunk.fileName} is ${(bytes / 1000).toFixed(0)} KB, over the ${WORKER_SIZE_LIMIT / 1000} KB limit. A fat dependency likely leaked into the bundle (see the shiki-shim plugin).`,
				)
		}
	},
})

// The token worker is a separate rollup graph (its grammar stubs must NOT apply
// to the main bundle, whose curated loaders resolve grammars lazily), but it is
// built by the SAME Vite instance right after the main build - one config, one
// command, no second builder. `configFile: false` keeps the sub-build from
// re-loading this config.
const tokenWorkerBuildPlugin = (): Plugin => ({
	name: 'token-worker-build',
	apply: 'build',
	async closeBundle() {
		await viteBuild({
			configFile: false,
			root: process.cwd(),
			resolve: { alias: frontendAliases },
			plugins: [
				makeShikiShimPlugin(true),
				makeWorkerLanguageStubPlugin(),
				workerGatePlugin(),
			],
			build: buildOptions({
				rollupOptions: {
					input: { worker: WORKER_ENTRY },
					// Self-contained module script: dynamic grammar imports are stubbed
					// anyway, so everything inlines into worker.js (no worker chunks).
					output: {
						format: 'es',
						entryFileNames: 'worker.js',
						inlineDynamicImports: true,
					},
				},
			}),
			logLevel: 'warn',
		})
	},
})

export default defineConfig({
	plugins: [
		makeShikiShimPlugin(false),
		budgetPlugin(),
		tokenWorkerBuildPlugin(),
		react(),
	],
	resolve: {
		alias: frontendAliases,
	},
	build: buildOptions({
		rollupOptions: {
			input: { ui: UI_ENTRY },
			output: {
				format: 'es',
				entryFileNames: '[name].js',
				chunkFileNames: 'chunks/[name]-[hash].js',
				hashCharacters: CHUNK_HASH_CHARS,
			},
		},
	}),
})
