import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { changeBlocks, changeStableKeyFromBlock } from '../git/change.js'
import { parseUnifiedDiff } from '../git/parse.js'
import { gitStats } from '../git/repo.js'

import { buildReviewState } from './build.js'
import { parsedDiffOf } from './diff-source.js'
import { change, state } from './fixtures.js'
import { resolveMovedFrom, resolveSkim } from './guide-resolve.js'
import { mergeReviewState } from './reconcile.js'

import type { ChangeState, Guide, ReviewState } from '../types.js'

// ── resolveMovedFrom (issue 03) ──────────────────────────────────────────────
// A guide-declared move: a.ts (a full working-tree deletion) + b.ts (an untracked addition,
// edited so content differs) → one rename-changed entry at b.ts.
function movedFromFixture(): ReviewState {
	return state({
		mode: 'repo',
		staged: false,
		files: [
			{
				path: 'a.ts',
				hunks: [
					{
						header: '',
						oldStart: 1,
						oldCount: 1,
						newStart: 0,
						newCount: 0,
						lines: [],
					},
				],
				oldPath: 'a.ts',
				newPath: undefined, // full deletion: +++ /dev/null
				contentHash: 'DEL',
				changeKind: 'deleted' as const,
			},
			{
				path: 'b.ts',
				hunks: [],
				oldPath: 'b.ts',
				newPath: 'b.ts', // untracked addition: no old side
				contentHash: 'ADD',
				changeKind: 'added' as const,
			},
		],
		changes: [
			change({
				id: 'a.ts:d1',
				path: 'a.ts',
				stableKey: 'd1',
				side: 'deletions',
			}),
		],
	})
}
const movedGuide = (movedFrom = 'a.ts'): Guide => ({
	overview: 'o',
	files: [
		{
			path: 'b.ts',
			order: 0,
			category: 'c',
			orientation: 'moved+edited',
			movedFrom,
		},
	],
})

void test('resolveMovedFrom merges a declared move into one rename-changed entry (issue 03)', () => {
	const base = movedFromFixture()
	const r = resolveMovedFrom(base, movedGuide(), { strict: true })
	assert.ok(r.ok)
	const { files, changes } = r.merged ?? base
	assert.equal(files.length, 1)
	const [m] = files
	assert.equal(m.path, 'b.ts')
	assert.equal(m.oldPath, 'a.ts')
	assert.equal(m.newPath, 'b.ts')
	assert.equal(m.changeKind, 'renamed')
	assert.equal(m.renamePure, false) // moved AND edited - not a pure rename
	assert.equal(m.contentHash, 'ADD') // reuses the untracked add's new-side OID (no re-hash)
	assert.equal(changes.length, 0) // the deletion's blocks are gone (UI derives new ones)
})

void test("resolveMovedFrom: strict aborts when the move doesn't resolve; lenient drops it", () => {
	const strict = movedFromFixture()
	const bad = resolveMovedFrom(strict, movedGuide('nope.ts'), {
		strict: true,
	})
	assert.equal(bad.ok, false)
	assert.match(bad.reason, /movedFrom "nope\.ts" did not resolve/)

	const lenient = movedFromFixture()
	const dropped = resolveMovedFrom(lenient, movedGuide('nope.ts'), {
		strict: false,
	})
	assert.ok(dropped.ok) // no error…
	assert.equal(dropped.merged, undefined) // …and the pair falls back to delete + add
	assert.equal(lenient.files.length, 2) // the base itself is never restructured
})

void test('resolveMovedFrom: movedFrom outside working repo mode is a strict error', () => {
	for (const over of [
		{ mode: 'pr' as const },
		{ staged: true },
		{ mode: 'file' as const },
	]) {
		const base = { ...movedFromFixture(), ...over }
		const r = resolveMovedFrom(base, movedGuide(), { strict: true })
		assert.equal(r.ok, false, JSON.stringify(over))
		assert.match(r.reason, /working repo mode/)
	}
})

// ── resolveSkim: guide skimBlocks → ChangeState.skim stamping ────────────────
// A diff with two blocks: an imports run (new lines 3-5) and a core() rewrite (new lines 8-9).
const SKIM_DIFF = `diff --git a/app.ts b/app.ts
index fb29c7d..ac6feef 100644
--- a/app.ts
+++ b/app.ts
@@ -1,8 +1,12 @@
 import { a } from "./a";
 import { b } from "./b";
+import { c } from "./c";
+import { d } from "./d";
+import { e } from "./e";
 
 export function core() {
-  return a() + b();
+  const total = a() + b() + c();
+  return total * 2;
 }
 
 export function untouched() {
`
// The same file after an agent edit: the imports are now unchanged context; only core() changed.
// The old skim span 3-5 no longer lands on any change block.
const SKIM_DIFF_REWRITTEN = `diff --git a/app.ts b/app.ts
index ac6feef..bbbbbbb 100644
--- a/app.ts
+++ b/app.ts
@@ -1,12 +1,12 @@
 import { a } from "./a";
 import { b } from "./b";
 import { c } from "./c";
 import { d } from "./d";
 import { e } from "./e";
 
 export function core() {
-  const total = a() + b() + c();
+  const total = a() + b() + c() + d();
   return total * 2;
 }
 
 export function untouched() {
`

// Build ChangeState[] from a raw diff exactly as assembleDiff does, so stableKeys line up
// with what resolveSkim derives.
function changesFromDiff(rawDiff: string): ChangeState[] {
	const out: ChangeState[] = []
	for (const f of parseUnifiedDiff(rawDiff)) {
		const p = f.newPath ?? f.oldPath ?? 'unknown'
		f.hunks.forEach((h, hunkIndex) => {
			changeBlocks(h).forEach(block => {
				const firstAdd = block.find(l => l.kind === 'add')
				const firstDelete = block.find(l => l.kind === 'delete')
				const side = firstAdd ? 'additions' : ('deletions' as const)
				const lineNumber =
					firstAdd?.newLine ?? firstDelete?.oldLine ?? h.newStart
				const stableKey = changeStableKeyFromBlock(block)
				out.push(
					change({
						id: `${p}:${stableKey}`,
						path: p,
						hunkIndex,
						side,
						lineNumber,
						stableKey,
					}),
				)
			})
		})
	}
	return out
}

function guideWith(
	skimBlocks: Array<{ lines: [number, number]; reason?: string }>,
	filePath = 'app.ts',
): Guide {
	return {
		overview: 'o',
		files: [
			{
				path: filePath,
				order: 0,
				category: 'Changes',
				orientation: 's',
				skimBlocks,
			},
		],
	}
}

void test('resolveSkim stamps the change block a span resolves to', () => {
	const changes = changesFromDiff(SKIM_DIFF)
	const r = resolveSkim(
		parseUnifiedDiff(SKIM_DIFF),
		changes,
		guideWith([{ lines: [3, 5], reason: 'imports' }]),
		{
			strict: true,
		},
	)
	assert.ok(r.ok)
	const imports = changes.find(c => c.stableKey === 'additions:3:0:3')
	const core = changes.find(c => c.stableKey === 'additions:8:1:2')
	assert.deepEqual(imports!.skim, { reason: 'imports' })
	assert.equal(core!.skim, undefined) // only the targeted block is stamped
})

void test('resolveSkim (strict) rejects a span that matches no change block, naming path + span', () => {
	const r = resolveSkim(
		parseUnifiedDiff(SKIM_DIFF),
		changesFromDiff(SKIM_DIFF),
		guideWith([{ lines: [100, 101] }]),
		{
			strict: true,
		},
	)
	assert.equal(r.ok, false)
	assert.match(r.reason, /app\.ts/)
	assert.match(r.reason, /100/)
})

void test('resolveSkim (strict) rejects a skimBlocks entry on a file absent from the diff', () => {
	const r = resolveSkim(
		parseUnifiedDiff(SKIM_DIFF),
		changesFromDiff(SKIM_DIFF),
		guideWith([{ lines: [1, 2] }], 'ghost.ts'),
		{
			strict: true,
		},
	)
	assert.equal(r.ok, false)
	assert.match(r.reason, /ghost\.ts/)
})

void test('resolveSkim (lenient) drops an unresolvable span instead of failing', () => {
	const changes = changesFromDiff(SKIM_DIFF)
	const r = resolveSkim(
		parseUnifiedDiff(SKIM_DIFF),
		changes,
		guideWith([
			{ lines: [3, 5], reason: 'imports' },
			{ lines: [100, 101] },
		]),
		{ strict: false },
	)
	assert.ok(r.ok) // the [100,101] span silently drops
	assert.deepEqual(
		changes.find(c => c.stableKey === 'additions:3:0:3')!.skim,
		{
			reason: 'imports',
		},
	)
})

void test('resolveSkim drops a stale skim after the block is rewritten (reload asymmetry)', () => {
	const guide = guideWith([{ lines: [3, 5], reason: 'imports' }])
	// Rewritten diff: the old span no longer resolves. Lenient reload drops it (no throw)...
	const changes = changesFromDiff(SKIM_DIFF_REWRITTEN)
	const lenient = resolveSkim(
		parseUnifiedDiff(SKIM_DIFF_REWRITTEN),
		changes,
		guide,
		{
			strict: false,
		},
	)
	assert.ok(lenient.ok)
	assert.ok(changes.every(c => !c.skim)) // no block skimmed; core renders pending
	// ...but a NEW guide with that span would be rejected outright.
	assert.equal(
		resolveSkim(
			parseUnifiedDiff(SKIM_DIFF_REWRITTEN),
			changesFromDiff(SKIM_DIFF_REWRITTEN),
			guide,
			{ strict: true },
		).ok,
		false,
	)
})

void test('resolveSkim clears prior stamps so re-resolution is idempotent', () => {
	const changes = changesFromDiff(SKIM_DIFF)
	resolveSkim(
		parseUnifiedDiff(SKIM_DIFF),
		changes,
		guideWith([{ lines: [3, 5] }]),
		{
			strict: true,
		},
	)
	assert.ok(changes.find(c => c.stableKey === 'additions:3:0:3')!.skim)
	// Re-resolve with a guide targeting the OTHER block: the first stamp must be cleared.
	resolveSkim(
		parseUnifiedDiff(SKIM_DIFF),
		changes,
		guideWith([{ lines: [8, 9] }]),
		{
			strict: true,
		},
	)
	assert.equal(
		changes.find(c => c.stableKey === 'additions:3:0:3')!.skim,
		undefined,
	)
	assert.ok(changes.find(c => c.stableKey === 'additions:8:1:2')!.skim)
})

void test('reload parses the unified diff exactly once, shared across build + skim (issue 06)', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'galley-parse-once-'))
	const gitq = (...args: string[]): void => {
		execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
	}
	try {
		gitq('init', '-q')
		gitq('config', 'user.email', 't@t.dev')
		gitq('config', 'user.name', 't')
		// Commit app.ts, then add an imports run + rewrite core() in the working tree - a diff whose
		// new-side lines 3-5 (the added imports) a guide skimBlocks span [3,5] resolves to.
		const OLD = [
			`import { a } from "./a";`,
			`import { b } from "./b";`,
			``,
			`export function core() {`,
			`  return a() + b();`,
			`}`,
			``,
		].join('\n')
		const NEW = [
			`import { a } from "./a";`,
			`import { b } from "./b";`,
			`import { c } from "./c";`,
			`import { d } from "./d";`,
			`import { e } from "./e";`,
			``,
			`export function core() {`,
			`  const total = a() + b() + c();`,
			`  return total * 2;`,
			`}`,
			``,
		].join('\n')
		await fs.writeFile(path.join(dir, 'app.ts'), OLD)
		gitq('add', '-A')
		gitq('commit', '-q', '-m', 'init')
		await fs.writeFile(path.join(dir, 'app.ts'), NEW)

		// Mirror the reload flow: build (parses once, seeds the memo) → merge → skim resolution
		// handed the memoized parse via parsedDiffOf(base) instead of re-parsing rawDiff.
		gitStats.parses = 0
		const base = await buildReviewState(dir, { session: 's' })
		assert.ok(base, 'state built')
		const merged = await mergeReviewState(base, null)
		merged.guide = guideWith([{ lines: [3, 5], reason: 'imports' }])
		const skim = resolveSkim(
			parsedDiffOf(base),
			merged.changes,
			merged.guide,
			{
				strict: false,
			},
		)
		assert.ok(skim.ok, 'skim resolved')
		assert.equal(
			gitStats.parses,
			1,
			'diff parsed exactly once across build + skim resolution',
		)
		assert.ok(
			merged.changes.some(c => c.skim),
			'the imports block was stamped skim - the shared parse actually drove resolution',
		)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})
