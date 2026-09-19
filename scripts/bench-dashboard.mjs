#!/usr/bin/env node
// Renders the benchmark history into one self-contained HTML dashboard (no server, no CDN) and
// records new runs into benchmarks/history.json, so the perf story of this UI stays a tracked
// artifact instead of a chat log.
//
//   node scripts/bench-dashboard.mjs               # render benchmarks/dashboard.html
//   node scripts/bench-dashboard.mjs --out <path>  # render somewhere else (e.g. ~/Desktop)
//   node scripts/bench-dashboard.mjs --check       # validate history + template, write nothing
//   node scripts/bench-dashboard.mjs --record <f>  # append the run object in <f> ("-" = stdin)
//
// A run is one JSON object; the shape the dashboard expects is documented in benchmarks/README.md.
// Recording is idempotent by run id: re-recording the same id replaces that run in place.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY = path.join(ROOT, 'benchmarks', 'history.json')
const TEMPLATE = path.join(ROOT, 'benchmarks', 'dashboard-template.html')
const DATA_START = '/*BENCH_DATA_START*/'
const DATA_END = '/*BENCH_DATA_END*/'
// In-repo by default: the timeline is a tracked artifact, and a copy in someone's home directory is
// not. `--out` renders anywhere else (a personal Desktop copy, a scratch comparison).
const DEFAULT_OUT = path.join(ROOT, 'benchmarks', 'dashboard.html')
const BYTES_PER_KB = 1024

const REQUIRED_RUN_KEYS = [
	'id',
	'fixture',
	'milestone',
	'date',
	'stagesMs',
	'pool',
]

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'))
	} catch (error) {
		fail(
			`${path.relative(ROOT, file)} is not readable JSON: ${error.message}`,
		)
		// fail() already exited; rethrowing keeps this function total (a value on one path, a
		// throw on the other) instead of falling off its end.
		throw error
	}
}

// A CLI's whole job is stdout/stderr, so write them directly (the lint preset bans console).
function print(message) {
	process.stdout.write(`${message}\n`)
}

function fail(message) {
	process.stderr.write(`bench-dashboard: ${message}\n`)
	process.exit(1)
}

// The dashboard's own contract: a run must carry the keys every chart reads, and the numbers must be
// numbers - a typo here would silently render as a gap in the evolution chart.
function validateRun(run, label) {
	for (const key of REQUIRED_RUN_KEYS)
		if (run[key] === undefined) fail(`${label}: missing "${key}"`)
	const numbers = { ...run.stagesMs, ...run.pool, ...run.spans }
	for (const [key, value] of Object.entries(numbers))
		if (typeof value !== 'number' || !Number.isFinite(value))
			fail(`${label}: "${key}" is not a finite number`)
	if (run.windows && !Array.isArray(run.windows))
		validateWindowTotals(run, label)
}

// windows is either an aggregate (totals per kind) or the per-window array the table renders.
function validateWindowTotals(run, label) {
	for (const key of ['count', 'rows', 'tokenizeMsTotal'])
		if (typeof run.windows[key] !== 'number')
			fail(`${label}: windows.${key} is not a number`)
}

function validateHistory(history) {
	for (const key of ['project', 'fixtures', 'milestones', 'runs'])
		if (history[key] === undefined) fail(`history: missing "${key}"`)
	if (!Array.isArray(history.runs)) fail('history.runs is not an array')
	const seen = new Set()
	for (const run of history.runs) {
		validateRun(run, `history run "${run.id}"`)
		if (seen.has(run.id)) fail(`history: duplicate run id "${run.id}"`)
		seen.add(run.id)
		if (!history.fixtures[run.fixture])
			fail(`history run "${run.id}": unknown fixture "${run.fixture}"`)
		const milestones = history.milestones.map(m => m.id)
		if (!milestones.includes(run.milestone))
			fail(
				`history run "${run.id}": unknown milestone "${run.milestone}"`,
			)
	}
	return seen
}

function record(source) {
	const raw =
		source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
	const run = JSON.parse(raw)
	validateRun(run, `record "${run.id}"`)
	const history = readJson(HISTORY)
	const index = history.runs.findIndex(existing => existing.id === run.id)
	if (index === -1) history.runs.push(run)
	else history.runs[index] = run
	validateHistory(history)
	writeFileSync(HISTORY, `${JSON.stringify(history, null, '\t')}\n`)
	print(
		`bench-dashboard: ${index === -1 ? 'recorded' : 'replaced'} run "${run.id}" (${history.runs.length} runs)`,
	)
}

// The template owns everything visual; this only swaps the data block, so the dashboard file stays
// openable straight from disk (file://) with no fetch and no build step.
function render(history, out) {
	const template = readFileSync(TEMPLATE, 'utf8')
	const start = template.indexOf(DATA_START)
	const end = template.indexOf(DATA_END)
	if (start === -1 || end === -1 || end < start)
		fail(
			`${path.relative(ROOT, TEMPLATE)}: data markers missing or out of order`,
		)
	if (template.indexOf(DATA_START, start + 1) !== -1)
		fail(`${path.relative(ROOT, TEMPLATE)}: more than one ${DATA_START}`)
	const html = `${template.slice(0, start + DATA_START.length)}
	const BENCH_DATA = ${JSON.stringify(history, null, '\t')};
	${template.slice(end)}`
	writeFileSync(out, html)
	const runs = history.runs.length
	print(
		`bench-dashboard: wrote ${out} (${runs} run${runs === 1 ? '' : 's'}, ${Math.round(html.length / BYTES_PER_KB)} KB)`,
	)
}

// argv[0] is node, argv[1] the script.
const ARGV_OFFSET = 2
const argv = process.argv.slice(ARGV_OFFSET)
function argValue(flag) {
	const index = argv.indexOf(flag)
	if (index === -1) return undefined
	return argv[index + 1]
}

const history = readJson(HISTORY)
validateHistory(history)

const recordSource = argValue('--record')
if (recordSource) record(recordSource)

// Dropping a bad measurement has to be as easy as adding one, or a broken point stays in the chart.
const forgetId = argValue('--forget')
if (forgetId) {
	const index = history.runs.findIndex(run => run.id === forgetId)
	if (index === -1) fail(`no run "${forgetId}" to forget`)
	history.runs.splice(index, 1)
	writeFileSync(HISTORY, `${JSON.stringify(history, null, '\t')}\n`)
	print(
		`bench-dashboard: forgot run "${forgetId}" (${history.runs.length} runs)`,
	)
}

if (argv.includes('--check')) {
	const markers = readFileSync(TEMPLATE, 'utf8').includes(DATA_START)
	if (!markers) fail(`${path.relative(ROOT, TEMPLATE)}: data markers missing`)
	print(
		`bench-dashboard: ok (${history.runs.length} runs, ${history.milestones.length} milestones)`,
	)
} else {
	render(readJson(HISTORY), argValue('--out') ?? DEFAULT_OUT)
}
