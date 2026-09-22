import { rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

import { checkBundleBudget } from './bundle-budget.mjs'

// The tokenization worker script is built from OUR entry (src/frontend/worker/diff-token-worker.ts)
// into its own asset: the token pool (src/frontend/widgets/diff-view/worker-pool.ts) instantiates module workers
// at /worker.js, and the desk serves it like ui.js. Building it separately keeps the
// tokenization engine off the main bundle AND off the main thread.
const workerEntry = fileURLToPath(
	new URL('../src/frontend/worker/diff-token-worker.ts', import.meta.url),
)

// The shell's static closure and all deferred chunks are budgeted independently. A tiny
// entry that still imports the grammars eagerly must fail the initial-load budget.
// dist/worker.js carries @pierre's render helpers and the token worker's own slice/merge code -
// NOT the grammars, which arrive as resolved data (see makeWorkerLanguageStubPlugin). The gate is a
// regression tripwire (a grammar or wasm leak back into the worker bundle), so it sits just above
// the current size rather than being generous.
const WORKER_SIZE_LIMIT = 900_000
const BYTES_PER_KB = 1000

const shimPath = fileURLToPath(
	new URL(
		'../src/frontend/shared/highlighting/shiki-shim.ts',
		import.meta.url,
	),
)
const emptyModule = 'export default {}; export {};'
// Named-export stub for worker.js's static oniguruma import - never called with 'shiki-js'.
const onigurumaStubModule =
	'export function createOnigurumaEngine() { throw new Error("oniguruma wasm engine was stubbed out of syneva\'s worker bundle (preferredHighlighter must be shiki-js)") }'
const fromPierre = importer => importer.includes('@pierre/diffs')
// The stub keys on the shared HIGHLIGHTING SLICE directory, not a source filename: any module
// under src/frontend/shared/highlighting (the curated grammar loaders) is stubbed out of the
// worker build, whatever its file ends up being called.
const fromCuratedLangs = importer => importer.includes('/shared/highlighting/')

// Frontend layer aliases (same map as tsconfig.json's paths; @contracts sinks to src/contracts).
const frontendAliases = {
	'@app': './src/frontend/app',
	'@pages': './src/frontend/pages',
	'@widgets': './src/frontend/widgets',
	'@features': './src/frontend/features',
	'@entities': './src/frontend/entities',
	'@shared': './src/frontend/shared',
	'@contracts': './src/contracts',
}

// The token worker never resolves grammars: the pool manager resolves them (see shiki-langs.ts's
// lazy loaders) and ships the RESOLVED data, which the worker only hands to loadLanguageSync. So
// every curated grammar module is stubbed out of the worker build - the whole set used to ride
// along as a 2.5 MB worker.js that each of the pool's four workers fetched and compiled on every
// cold load. Touching the stub is a loud error: the worker started resolving languages itself.
const languageStubModule =
	'export default new Proxy({}, { get() { throw new Error("a curated grammar module was resolved inside the token worker: grammars must arrive as RESOLVED data from the pool manager (see src/frontend/shared/highlighting/shiki-langs.ts)") } })'
const makeWorkerLanguageStubPlugin = () => ({
	name: 'shiki-worker-language-stub',
	setup(build) {
		build.onResolve({ filter: /^shiki\/dist\/langs\// }, args =>
			fromCuratedLangs(args.importer) || fromPierre(args.importer)
				? { path: 'shiki-lang-stub', namespace: 'shiki-lang-stub' }
				: undefined,
		)
		build.onLoad({ filter: /.*/, namespace: 'shiki-lang-stub' }, () => ({
			contents: languageStubModule,
		}))
	},
})

// @pierre/diffs imports shiki v3's full barrel (`from "shiki"`), which statically pulls ~180
// grammars + a 607 KB inlined oniguruma wasm - a second, near-complete shiki alongside the lean
// one markdown.ts builds from shiki/core. Reroute ONLY @pierre/diffs' bare `shiki` specifier to a
// local shim backed by the curated set; Syneva's own deep imports (shiki/core, shiki/engine/*,
// shiki/dist/*) are left untouched so they keep resolving to the real v4 package. `shiki/wasm`
// (referenced by @pierre's never-taken oniguruma path) resolves to an empty stub so the wasm
// engine can't be bundled - the shim forces the JS regex engine regardless.
const makeShikiShimPlugin = ({ stubOniguruma = false } = {}) => ({
	name: 'shiki-shim',
	setup(build) {
		build.onResolve({ filter: /^shiki$/ }, args =>
			fromPierre(args.importer) ? { path: shimPath } : undefined,
		)
		build.onResolve({ filter: /^shiki\/wasm$/ }, args =>
			fromPierre(args.importer)
				? { path: 'shiki-wasm-stub', namespace: 'shiki-wasm-stub' }
				: undefined,
		)
		build.onLoad({ filter: /.*/, namespace: 'shiki-wasm-stub' }, args => ({
			contents:
				args.pluginData === 'oniguruma'
					? onigurumaStubModule
					: emptyModule,
		}))
		// worker.js statically imports `shiki/engine/oniguruma` and only calls it when the pool
		// was configured with `preferredHighlighter: 'shiki-wasm'` - Syneva always pins 'shiki-js'.
		// Stub it so the wasm runtime (wasmoon) can't reach the worker bundle; if the path is ever
		// taken anyway the stub throws loudly rather than rendering silently unhighlighted. Only
		// the WORKER build needs this: no main-bundle module imports the oniguruma engine.
		if (!stubOniguruma) return
		build.onResolve({ filter: /^shiki\/engine\/oniguruma$/ }, args =>
			fromPierre(args.importer)
				? {
						path: 'shiki-oniguruma-stub',
						namespace: 'shiki-wasm-stub',
						pluginData: 'oniguruma',
					}
				: undefined,
		)
	},
})

const options = {
	entryPoints: ['src/frontend/app/main.ts'],
	bundle: true,
	format: 'esm',
	target: 'es2022',
	outdir: 'dist',
	entryNames: 'ui',
	chunkNames: 'chunks/[name]-[hash]',
	splitting: true,
	metafile: true,
	alias: frontendAliases,
	loader: { '.wasm': 'binary' },
	minify: true,
	logLevel: 'info',
	plugins: [makeShikiShimPlugin()],
}

// The worker bundle: same shiki shim (worker.js imports the bare `shiki` barrel too), plus the
// oniguruma stub above. Module-format so { type: 'module' } workers can load it.
const workerOptions = {
	entryPoints: [workerEntry],
	bundle: true,
	format: 'esm',
	target: 'es2022',
	outfile: 'dist/worker.js',
	minify: true,
	logLevel: 'info',
	alias: frontendAliases,
	plugins: [
		makeShikiShimPlugin({ stubOniguruma: true }),
		makeWorkerLanguageStubPlugin(),
	],
}

function gate(outfile, limit) {
	const bytes = statSync(outfile).size
	const kb = (bytes / BYTES_PER_KB).toFixed(0)
	if (bytes > limit) {
		process.stderr.write(
			`esbuild: ${outfile} is ${kb} KB, over the ${limit / BYTES_PER_KB} KB limit. ` +
				`A fat dependency likely leaked into the bundle (see the shiki-shim plugin).\n`,
		)
		process.exit(1)
	}
	process.stderr.write(
		`esbuild: ${outfile} is ${kb} KB (limit ${limit / BYTES_PER_KB} KB)\n`,
	)
}

// These hashed assets are generated exclusively by this build; never publish stale chunks
// from earlier builds. During watch, retain prior hashes until the next process starts.
rmSync('dist/chunks', { recursive: true, force: true })

if (process.argv.includes('--watch')) {
	// The worker bundle only changes when its dependency set changes (@pierre release, the shim),
	// so it is watched alongside the UI rather than rebuilt on every dev save.
	const workerCtx = await esbuild.context(workerOptions)
	const ctx = await esbuild.context(options)
	await workerCtx.watch()
	await ctx.watch()
	process.stderr.write(
		'esbuild: watching src/frontend → dist/ui.js + worker → dist/worker.js\n',
	)
} else {
	await esbuild.build(workerOptions)
	gate(workerOptions.outfile, WORKER_SIZE_LIMIT)
	const bundle = await esbuild.build(options)
	checkBundleBudget(bundle.metafile.outputs, 'dist/ui.js')
	const outputs = Object.fromEntries(
		Object.entries(bundle.metafile.outputs).map(
			([filename, { bytes, imports }]) => [filename, { bytes, imports }],
		),
	)
	writeFileSync('dist/ui-manifest.json', JSON.stringify(outputs))
}
