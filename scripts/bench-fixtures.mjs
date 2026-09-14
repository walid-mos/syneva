// Build the fixture repos the browser bench runs against. Each repo is a git repo with a
// clean base commit, then a working-tree rewrite the desk will diff.
//
// Fixture knobs: file count, how many files changed, per-file size, and (for bigfile/patho)
// one deliberate outlier file. `share` ideals: rewriteLines strides by `share`, so a giant
// file like giant-surface.ts (8,000 lines, share .25) stays under the desk's per-file
// oversized stamp (diff-files.ts: >1MB diff bytes, >5,000 changed lines, >1MB file).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EXT = 'ts'

// One realistic TS file body: nested objects so shiki has work to do per line.
const body = (n, tag) =>
	Array.from(
		Array(n),
		(_, i) =>
			`export const ${tag}${i}: { id: number; label: string; meta?: Record<string, unknown> } = { id: ${i}, label: "item-${tag}-${i}", nested: { deep: [1, 2, 3] } as const }`,
	).join('\n')

// Rewrite a `share` of the file's lines on a deterministic stride. `salt` colors the labels
// so a rewrite differs from both the committed base and any other pass (a re-run with the
// same stride still produces a diff, because the marker labels change).
const rewriteLines = (text, share, salt) => {
	const lines = text.split('\n')
	const stride = Math.max(2, Math.round(1 / share))
	return lines
		.map((line, i) =>
			i % stride === 0
				? line.replace(
						'label: "item-',
						`label: "REVIEWED-${salt}-${i}-item-`,
					)
				: line,
		)
		.join('\n')
}

// Fully rewritten file (every line): galley's worst parse path while still small enough to
// render (2,400 lines * 2 sides < the 5,000 changed-line stamp).
const fullyUpdated = n =>
	Array.from(
		Array(n),
		(_, i) =>
			`// REVIEWED-rewrite-${i}-bench: { id: ${i}, label: "item-${i}", nested: { deep: [1, 2, 3] } as const }`,
	).join('\n')

const SPECS = [
	{ name: 'tiny', files: 8, changed: 8, lines: 40 },
	{ name: 'small', files: 40, changed: 40, lines: 150 },
	{ name: 'medium', files: 200, changed: 120, lines: 400 },
	{ name: 'large', files: 1000, changed: 300, lines: 700 },
	// bigfile: ordinary desk plus two monsters that must NOT match the per-file oversized
	// stamp: an 8,000-line file with 2,000 changed (4,000 counted) and a 16,000-line file
	// with 60 changed. The 16k file is also 2.4MB, which DOES stamp it oversized by bytes -
	// the desk shows its summary card, and the bench drives "Load diff anyway".
	{ name: 'bigfile', files: 3, changed: 3, lines: 200, special: 'bigfile' },
	// patho: a 2,400-line file where every line was rewritten.
	{ name: 'patho', files: 3, changed: 3, lines: 120, special: 'patho' },
]

export function buildFixtures(root) {
	rmSync(root, { recursive: true, force: true })
	mkdirSync(root, { recursive: true })
	const built = []
	for (const spec of SPECS) {
		const dir = path.join(root, spec.name)
		mkdirSync(path.join(dir, 'src'), { recursive: true })
		const names = []
		const contents = []
		for (let i = 0; i < spec.files; i++) {
			const name = `src/module-${['core', 'shell', 'web'][i % 3]}-${i}.ts`
			const text = body(spec.lines, `m${i}`)
			names.push(name)
			contents.push(text)
			writeFileSync(path.join(dir, name), text)
		}
		if (spec.special === 'bigfile') {
			for (const [name, lines, share] of [
				['src/giant-surface.ts', 8000, 0.25],
				['src/giant-list.ts', 16000, 60 / 16000],
			]) {
				names.push(name)
				writeFileSync(
					path.join(dir, name),
					body(lines, name.replace(/\W/g, '')),
				)
			}
			// Oversized-by-bytes giant first in review order (the desk opens it by default):
			// the card path + Enter's "load anyway" flow get exercised.
			names.reverse()
		}
		if (spec.special === 'patho') {
			names.push('src/fully-rewritten.ts')
			writeFileSync(
				path.join(dir, 'src/fully-rewritten.ts'),
				fullyUpdated(2400),
			)
		}

		const git = (...args) =>
			execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
		git('init', '-q')
		git('config', 'user.email', 'bench@local')
		git('config', 'user.name', 'bench')
		git('add', '-A')
		git('commit', '-q', '-m', 'base')

		// Working-tree rewrite: the first `changed` files get a 25% rewrite; the giant files
		// get their tuned shares.
		for (let i = 0; i < spec.files && i < spec.changed; i++) {
			writeFileSync(
				path.join(dir, names[i]),
				rewriteLines(contents[i], 0.25, i + 1),
			)
		}
		if (spec.special === 'bigfile') {
			writeFileSync(
				path.join(dir, 'src/giant-surface.ts'),
				rewriteLines(body(8000, 'srcgiantsurfacets'), 0.25, 7),
			)
			writeFileSync(
				path.join(dir, 'src/giant-list.ts'),
				rewriteLines(body(16000, 'srcgiantlistts'), 60 / 16000, 9),
			)
		}
		writeFileSync(
			path.join(dir, 'README.md'),
			`# bench repo ${spec.name}\n`,
		)
		built.push(spec.name)
	}
	return built
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = path.join('/tmp', 'galley-bench', 'repos')
	console.log(buildFixtures(root).join('\n'))
}
