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

export const INITIAL_UI_BYTES_LIMIT = 200_000
const TOTAL_UI_BYTES_LIMIT = 3_800_000

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
