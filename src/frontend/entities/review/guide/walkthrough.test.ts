import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { lineStats, walkthroughGroups, walkRows } from './walkthrough'

import type { GuideFile } from '../model'
import type { FileReviewState } from '../model'

// The file shape the helpers read - named off the helper itself so the fixture cannot drift.
type FileFixture = Parameters<typeof lineStats>[0][number]

// Compact fixture notation: "aadc" supplies the metadata for two additions and one removal.
function file(path: string, ...lineKinds: string[]): FileFixture {
	const kinds = lineKinds.join('').split('')
	return {
		path,
		added: kinds.filter(kind => kind === 'a').length,
		removed: kinds.filter(kind => kind === 'd').length,
	}
}

function guideFile(
	path: string,
	category: string,
	extra: Partial<GuideFile> = {},
): GuideFile {
	return { path, order: 0, category, ...extra }
}

const allPending = (): FileReviewState => 'pending'

void test('lineStats reads per-file counts without parsed hunks', () => {
	const stats = lineStats([
		file('a.ts', 'aacd', 'ad'),
		file('b.ts', 'ccc'),
		file('c.ts'),
	])
	assert.deepEqual(stats.get('a.ts'), { added: 3, removed: 2 })
	assert.deepEqual(stats.get('b.ts'), { added: 0, removed: 0 })
	assert.deepEqual(stats.get('c.ts'), { added: 0, removed: 0 })
})

void test("lineStats reads the builder's +/- stamps for a hunk-less file (full-file add)", () => {
	// A hunk-less full-file add has no hunk to sum; the lean builder stamps its whole-content +count.
	const stats = lineStats([
		{ path: 'new.ts', added: 3, removed: 0 },
		{ path: 'empty.ts', added: 0, removed: 0 },
	])
	assert.deepEqual(stats.get('new.ts'), { added: 3, removed: 0 })
	assert.deepEqual(stats.get('empty.ts'), { added: 0, removed: 0 })
})

void test('walkthroughGroups starts a new section each time the category changes (run-length)', () => {
	const groups = walkthroughGroups(
		[
			guideFile('core/a.ts', 'Core'),
			guideFile('docs/d.md', 'Docs'),
			guideFile('core/b.ts', 'Core'),
		],
		[
			file('docs/d.md', 'a'),
			file('core/a.ts', 'aa'),
			file('core/b.ts', 'd'),
		],
		allPending,
	)
	// The trailing Core does NOT fold back up - it is its own section, so the display mirrors
	// the guide order (Core → Docs → Core) instead of collapsing to two groups.
	const categories = groups.map(g => g.category)
	assert.ok(isDeepStrictEqual(categories, ['Core', 'Docs', 'Core']))
	const firstGroupPaths = groups[0].files.map(f => f.path)
	assert.ok(isDeepStrictEqual(firstGroupPaths, ['core/a.ts']))
	const trailingGroupPaths = groups[2].files.map(f => f.path)
	assert.ok(isDeepStrictEqual(trailingGroupPaths, ['core/b.ts']))
})

void test('walkthroughGroups keeps a run together across a guide entry absent from the diff', () => {
	// gone.ts (Other category, not in the diff) is skipped without splitting the Core run.
	const groups = walkthroughGroups(
		[
			guideFile('a.ts', 'Core'),
			guideFile('gone.ts', 'Tests'),
			guideFile('b.ts', 'Core'),
		],
		[file('a.ts', 'a'), file('b.ts', 'a')],
		allPending,
	)
	const categories = groups.map(g => g.category)
	assert.ok(isDeepStrictEqual(categories, ['Core']))
	const paths = groups[0].files.map(f => f.path)
	assert.ok(isDeepStrictEqual(paths, ['a.ts', 'b.ts']))
})

void test('walkthroughGroups: roll-ups, basename split, and fileIndex into the diff list', () => {
	const groups = walkthroughGroups(
		[guideFile('src/ui/a.ts', 'Core'), guideFile('b.ts', 'Core')],
		[file('b.ts', 'd'), file('src/ui/a.ts', 'aad')],
		p => (p === 'b.ts' ? 'approved' : 'pending'),
	)
	const [core] = groups
	assert.equal(core.total, 2)
	assert.equal(core.done, 1)
	assert.equal(core.added, 2)
	assert.equal(core.removed, 2)
	const [a] = core.files
	assert.equal(a.dir, 'src/ui/')
	assert.equal(a.name, 'a.ts')
	assert.equal(a.fileIndex, 1) // index into the diff's file list, not the guide's
	assert.equal(core.files[1].state, 'approved')
})

void test('walkthroughGroups skips guide entries absent from the diff (guideOrder rule)', () => {
	const groups = walkthroughGroups(
		[guideFile('gone.ts', 'Ghost'), guideFile('a.ts', 'Core')],
		[file('a.ts', 'a')],
		allPending,
	)
	const categories = groups.map(g => g.category)
	assert.ok(isDeepStrictEqual(categories, ['Core']))
})

void test('walkthroughGroups puts unlisted diff files in a trailing Other group', () => {
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core')],
		[file('stray.ts', 'a'), file('a.ts', 'a')],
		allPending,
	)
	assert.equal(groups.length, 2)
	const [, other] = groups
	assert.equal(other.other, true)
	assert.equal(other.category, 'Other')
	assert.ok(
		isDeepStrictEqual(
			other.files.map(f => f.path),
			['stray.ts'],
		),
	)
})

void test('walkthroughGroups with no guide files is just the Other group', () => {
	const groups = walkthroughGroups([], [file('a.ts', 'a')], allPending)
	assert.equal(groups.length, 1)
	assert.equal(groups[0].other, true)
})

void test('walkRows flattens to cat,file… rows and marks only the active path', () => {
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core'), guideFile('b.ts', 'Core')],
		[file('a.ts', 'a'), file('b.ts', 'a'), file('stray.ts', 'a')],
		p => (p === 'stray.ts' ? 'pending' : 'approved'),
	)
	const rows = walkRows(groups, 'b.ts')
	assert.deepEqual(
		rows.map(r => r.kind),
		['cat', 'file', 'file', 'cat', 'file'],
	)
	const rowClasses = rows.map(r => (r.kind === 'file' ? r.cls : ''))
	assert.ok(isDeepStrictEqual(rowClasses, ['', '', 'active', '', '']))
	// Core is fully reviewed → complete; Other still has the pending stray.
	const cats = rows.filter(r => r.kind === 'cat')
	const completion = cats.map(c => c.complete)
	assert.ok(isDeepStrictEqual(completion, [true, false]))
})

void test('walkRows: no active row while the Overview is showing (null activePath)', () => {
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core')],
		[file('a.ts', 'a')],
		allPending,
	)
	const rows = walkRows(groups, null)
	assert.ok(rows.every(r => r.kind === 'cat' || r.cls === ''))
})

void test('walkRows: a repeated category yields distinct keys and per-occurrence jumpIndex', () => {
	// Core appears twice (positions 0 and 2 of the guide); the diff orders them differently.
	const groups = walkthroughGroups(
		[
			guideFile('core/a.ts', 'Core'),
			guideFile('t/b.ts', 'Tests'),
			guideFile('core/c.ts', 'Core'),
		],
		[file('t/b.ts', 'a'), file('core/a.ts', 'a'), file('core/c.ts', 'a')],
		allPending,
	)
	const cats = walkRows(groups, null).filter(r => r.kind === 'cat')
	const categories = cats.map(c => c.category)
	assert.ok(isDeepStrictEqual(categories, ['Core', 'Tests', 'Core']))
	// Keys must be unique so Alpine's x-for never reuses a header DOM node across runs.
	assert.ok(Object.is(new Set(cats.map(c => c.key)).size, cats.length))
	// Each Core header jumps to ITS OWN file (diff indices: a.ts=1, c.ts=2), not the first Core.
	assert.ok(Object.is(cats[0].jumpIndex, 1))
	assert.ok(Object.is(cats[2].jumpIndex, 2))
})

void test('walkthroughGroups gathers pure renames into one trailing Renamed group', () => {
	// a.ts and stray.ts are pure renames → they leave their normal groups (Core / Other) and
	// collect in a trailing "Renamed" group; b.ts stays in Core.
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core'), guideFile('b.ts', 'Core')],
		[file('a.ts', 'a'), file('b.ts', 'a'), file('stray.ts', 'a')],
		allPending,
		{
			renamed: p => p === 'a.ts' || p === 'stray.ts',
			distilled: () => false,
		},
	)
	const categories = groups.map(g => g.category)
	assert.ok(isDeepStrictEqual(categories, ['Core', 'Renamed']))
	const [core] = groups
	const corePaths = core.files.map(f => f.path)
	assert.ok(isDeepStrictEqual(corePaths, ['b.ts']))
	const [, renamed] = groups
	assert.equal(renamed.renamed, true)
	assert.equal(renamed.total, 2)
	// Guide-listed first, then the unlisted stray
	const renamedPaths = renamed.files.map(f => f.path)
	assert.ok(isDeepStrictEqual(renamedPaths, ['a.ts', 'stray.ts']))
})

void test('walkthroughGroups: a renamed file between same-category files does not split the run', () => {
	// a and c are Core with b (Core, a pure rename) between them - the run must stay one group.
	const groups = walkthroughGroups(
		[
			guideFile('a.ts', 'Core'),
			guideFile('b.ts', 'Core'),
			guideFile('c.ts', 'Core'),
		],
		[file('a.ts', 'a'), file('b.ts', 'a'), file('c.ts', 'a')],
		allPending,
		{ renamed: p => p === 'b.ts', distilled: () => false },
	)
	const categories = groups.map(g => g.category)
	assert.ok(isDeepStrictEqual(categories, ['Core', 'Renamed']))
	const paths = groups[0].files.map(f => f.path)
	assert.ok(isDeepStrictEqual(paths, ['a.ts', 'c.ts']))
})

void test("walkRows hides the Renamed group's file rows until expanded", () => {
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core'), guideFile('b.ts', 'Core')],
		[file('a.ts', 'a'), file('b.ts', 'a')],
		allPending,
		{ renamed: p => p === 'b.ts', distilled: () => false },
	)
	// Collapsed (default): the Renamed header shows, its file row does not.
	const collapsed = walkRows(groups, null, { renamed: false })
	assert.deepEqual(
		collapsed.map(r => r.kind),
		['cat', 'file', 'cat'],
	)
	const renamedCat = collapsed.find(r => r.kind === 'cat' && r.renamed)
	assert.ok(renamedCat?.kind === 'cat' && !renamedCat.open)
	// Expanded: the renamed file row appears under its header.
	const expanded = walkRows(groups, null, { renamed: true })
	assert.deepEqual(
		expanded.map(r => r.kind),
		['cat', 'file', 'cat', 'file'],
	)
	const renamedCatOpen = expanded.find(r => r.kind === 'cat' && r.renamed)
	assert.ok(renamedCatOpen?.kind === 'cat' && renamedCatOpen.open)
})

void test("walkRows: a category-header jumpIndex prefers the group's first pending file", () => {
	// core/a is approved, core/c is pending → the header should land on core/c (diff index 2).
	const groups = walkthroughGroups(
		[guideFile('core/a.ts', 'Core'), guideFile('core/c.ts', 'Core')],
		[file('x.ts', 'a'), file('core/a.ts', 'a'), file('core/c.ts', 'a')],
		p => (p === 'core/a.ts' ? 'approved' : 'pending'),
	)
	const cat = walkRows(groups, null).find(r => r.kind === 'cat')
	assert.ok(Object.is(cat!.jumpIndex, 2))
})

void test('walkthroughGroups: a pure rename gets movedFrom and folds into the Renamed group (issue 01)', () => {
	const files = [
		file('core/a.ts', 'aa'),
		{
			path: 'lib/new.ts',
			added: 0,
			removed: 0,
			oldPath: 'lib/old.ts',
			newPath: 'lib/new.ts',
		},
	]
	const groups = walkthroughGroups(
		[guideFile('core/a.ts', 'Core')],
		files,
		allPending,
		{ renamed: p => p === 'lib/new.ts', distilled: () => false }, // the moved file has left the main flow
	)
	const renamed = groups.find(g => g.renamed)
	assert.ok(renamed)
	assert.equal(renamed.files.length, 1)
	assert.equal(renamed.files[0].path, 'lib/new.ts')
	assert.equal(renamed.files[0].movedFrom, 'lib/old.ts') // drives the "← old" arrow
	const core = groups.find(g => g.category === 'Core')
	assert.ok(core)
	assert.equal(core.files[0].movedFrom, '') // a normal edit is not a rename
})

void test('the hide-reviewed lens folds fully-approved files into a trailing Reviewed group', () => {
	// a.ts is APPROVED (stateOf says so): with the distilled fold it leaves Core and gathers
	// in the trailing "Reviewed" group; b.ts stays in Core. Reviewed ranks after Renamed.
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core'), guideFile('b.ts', 'Core')],
		[file('a.ts', 'ad'), file('b.ts', 'a')],
		(p: string): FileReviewState => (p === 'a.ts' ? 'approved' : 'pending'),
		{ renamed: p2 => p2 === 'stray.ts', distilled: p2 => p2 === 'a.ts' },
	)
	assert.ok(
		isDeepStrictEqual(
			groups.map(g => g.category),
			['Core', 'Reviewed'],
		),
	)
	const [core, reviewed] = groups
	assert.ok(
		isDeepStrictEqual(
			core.files.map(f => f.path),
			['b.ts'],
		),
	)
	assert.equal(reviewed.reviewed, true)
	assert.equal(reviewed.renamed, false)
	assert.ok(
		isDeepStrictEqual(
			reviewed.files.map(f => f.path),
			['a.ts'],
		),
	)
	// An approved file also leaves the "Other" group of unlisted files.
	const unlistedGroups = walkthroughGroups(
		[guideFile('a.ts', 'Core')],
		[file('a.ts', 'ad'), file('stray.ts', 'a')],
		(p: string): FileReviewState =>
			p === 'stray.ts' ? 'approved' : 'pending',
		{ renamed: () => false, distilled: p2 => p2 === 'stray.ts' },
	)
	assert.ok(
		isDeepStrictEqual(
			unlistedGroups.map(g => g.category),
			['Core', 'Reviewed'],
		),
	)
})

void test("walkRows hides the Reviewed group's file rows until expanded, like Renamed", () => {
	const groups = walkthroughGroups(
		[guideFile('a.ts', 'Core'), guideFile('b.ts', 'Core')],
		[file('a.ts', 'ad'), file('b.ts', 'a')],
		(p: string): FileReviewState => (p === 'a.ts' ? 'approved' : 'pending'),
		{ renamed: () => false, distilled: p2 => p2 === 'a.ts' },
	)
	const collapsed = walkRows(groups, null, { reviewed: false })
	// Core's header + its pending file, then the collapsed Reviewed header (no file rows).
	assert.deepEqual(
		collapsed.map(r => r.kind),
		['cat', 'file', 'cat'],
	)
	const reviewedCat = collapsed.find(r => r.kind === 'cat' && r.reviewed)
	assert.ok(reviewedCat?.kind === 'cat' && !reviewedCat.open)
	const expanded = walkRows(groups, null, { reviewed: true })
	assert.deepEqual(
		expanded.map(r => r.kind),
		['cat', 'file', 'cat', 'file'],
	)
	const openCat = expanded.find(r => r.kind === 'cat' && r.reviewed)
	assert.ok(openCat?.kind === 'cat' && openCat.open)
})
