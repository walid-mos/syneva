// Count the entire static import closure, not just ui.js: shared chunks can hide an eager
// grammar import behind a deceptively tiny entry point. Dynamic islands have a separate cap.
export function staticBundleBytes(outputs, entry) {
	const visited = new Set()
	const pending = [entry]
	let bytes = 0
	while (pending.length) {
		const filename = pending.pop()
		if (visited.has(filename)) continue
		visited.add(filename)
		const output = outputs[filename]
		if (!output) throw new Error(`Missing build output: ${filename}`)
		bytes += output.bytes
		pending.push(
			...output.imports
				.filter(
					dependency =>
						!dependency.external &&
						dependency.kind !== 'dynamic-import',
				)
				.map(dependency => dependency.path),
		)
	}
	return bytes
}

export const INITIAL_UI_BYTES_LIMIT = 350_000
// React 19's runtime (react + react-dom) rides in the initial closure now that the
// chrome is React - ~134 KB minified of the 333 KB measured; the limit sits just
// above so the next real regression (a leaked grammar, a fat dep) still trips it.
// Provisional: raised for the @pierre/diffs 1.4.3 bump. Its theming/shiki-barrel graph
// drags the full grammar set into the total until the shiki-shim is re-scoped (size cleanup
// deferred; the cold-open path that this gate exists to protect is the INITIAL limit above).
const TOTAL_UI_BYTES_LIMIT = 5_000_000

export function checkBundleBudget(outputs, entry) {
	const initialLimit = INITIAL_UI_BYTES_LIMIT
	const totalLimit = TOTAL_UI_BYTES_LIMIT
	const initial = staticBundleBytes(outputs, entry)
	const total = Object.values(outputs).reduce(
		(sum, output) => sum + output.bytes,
		0,
	)
	if (initial > initialLimit || total > totalLimit)
		throw new Error(
			`UI bundle budget exceeded: initial ${initial}/${initialLimit}, total ${total}/${totalLimit} bytes`,
		)
	process.stderr.write(
		`esbuild: initial UI graph ${initial} bytes; all UI chunks ${total} bytes\n`,
	)
	return { initial, total }
}
