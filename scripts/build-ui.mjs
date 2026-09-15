import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

// The @pierre/diffs worker script is bundled as its own asset: the UI hands a WorkerPoolManager
// a factory that points at /worker.js (see src/ui/render/worker-pool.ts), and the desk serves it
// like ui.js. Building it separately keeps the tokenization/highlight engine off the main bundle
// AND off the main thread.
const workerEntry = fileURLToPath(
	import.meta.resolve('@pierre/diffs/worker/worker.js'),
)

// dist/ui.js is a single un-split bundle served to the tab. Gate it so an accidental fat
// dependency (e.g. shiki's full bundle - see the plugin below) can't silently balloon it back.
// The floor is the curated grammars themselves (~2 MB of @shikijs/langs, bundled once - cpp alone
// is ~650 KB); the total sits near 3 MB. This gate still catches a re-introduced fat barrel (that
// regression is +9 MB) or the oniguruma wasm (+600 KB). Reaching "hundreds of KB" would require
// lazy-loading grammar chunks (a code-split + a server route to serve them) - out of scope here.
// 3.2 → 3.3 MB when light mode added six curated light themes (~170 KB of theme JSON).
// 3.3 → 3.4 MB for the virtualized renderer - headroom until the chunk split
// retires this whole-file cap for a budgeted lazy graph.
const SIZE_LIMIT = 3_400_000
// dist/worker.js carries the same curated grammars plus @pierre's worker engine, so its floor is
// comparable; the gate is a regression tripwire (a wasm/fat-barrel leak), generous rather than
// tight to avoid false CI failures across @pierre releases.
const WORKER_SIZE_LIMIT = 3_800_000
const BYTES_PER_KB = 1000

const shimPath = fileURLToPath(
	new URL('../src/ui/shiki-shim.ts', import.meta.url),
)
const emptyModule = 'export default {}; export {};'
// Named-export stub for worker.js's static oniguruma import - never called with 'shiki-js'.
const onigurumaStubModule =
	'export function createOnigurumaEngine() { throw new Error("oniguruma wasm engine was stubbed out of galley\'s worker bundle (preferredHighlighter must be shiki-js)") }'
const fromPierre = importer => importer.includes('@pierre/diffs')

// @pierre/diffs imports shiki v3's full barrel (`from "shiki"`), which statically pulls ~180
// grammars + a 607 KB inlined oniguruma wasm - a second, near-complete shiki alongside the lean
// one markdown.ts builds from shiki/core. Reroute ONLY @pierre/diffs' bare `shiki` specifier to a
// local shim backed by the curated set; Galley's own deep imports (shiki/core, shiki/engine/*,
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
		// was configured with `preferredHighlighter: 'shiki-wasm'` - Galley always pins 'shiki-js'.
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
	entryPoints: ['src/ui/main.ts'],
	bundle: true,
	format: 'esm',
	target: 'es2022',
	outfile: 'dist/ui.js',
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
	plugins: [makeShikiShimPlugin({ stubOniguruma: true })],
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

if (process.argv.includes('--watch')) {
	// The worker bundle only changes when its dependency set changes (@pierre release, the shim),
	// so it is watched alongside the UI rather than rebuilt on every dev save.
	const workerCtx = await esbuild.context(workerOptions)
	const ctx = await esbuild.context(options)
	await workerCtx.watch()
	await ctx.watch()
	process.stderr.write(
		'esbuild: watching src/ui → dist/ui.js + worker → dist/worker.js\n',
	)
} else {
	await esbuild.build(workerOptions)
	gate(workerOptions.outfile, WORKER_SIZE_LIMIT)
	await esbuild.build(options)
	gate(options.outfile, SIZE_LIMIT)
}
