// Stage timeline for the desk's load -> color path. Every stage is one bounded push, recorded from
// module evaluation (so `t = 0` is navigation start), and the whole timeline is exposed on
// `window.synevaPerf` for the browser bench (benchmarks/browser-bench.mjs) and for diagnosing a slow
// desk in the field.
//
// Why it exists: the load path crosses four contexts (main thread, HTTP, token workers, the
// @pierre renderer), so "the page loads and the colors arrive later" can only be attributed with
// per-stage stamps. Marks are cheap (~1 us) and never throw; a stage name is a constant, never
// built from data, so the timeline stays greppable.
const MAX_MARKS = 600
// Sub-millisecond stage costs matter at this scale (a window tokenizes in single-digit ms).
const TENTHS_PER_MS = 10

export type PerfDetail = Record<string, number | string | boolean>
export type PerfMark = { stage: string; t: number; detail?: PerfDetail }

const marks: PerfMark[] = []
// Stage -> first landing stamp, for the headline numbers (time to rows, to first color, ...).
const firsts = new Map<string, number>()

export function perfMark(stage: string, detail?: PerfDetail): void {
	const t = Math.round(performance.now() * TENTHS_PER_MS) / TENTHS_PER_MS
	if (!firsts.has(stage)) firsts.set(stage, t)
	if (marks.length < MAX_MARKS)
		marks.push(detail ? { stage, t, detail } : { stage, t })
}

// Wall time of one synchronous span, stamped on exit: `const end = perfSpan('x')` then `end(detail)`.
export function perfSpan(stage: string): (detail?: PerfDetail) => void {
	const start = performance.now()
	return detail =>
		perfMark(stage, {
			ms: Math.round(performance.now() - start),
			...detail,
		})
}

// First landing of a stage, or undefined when it never happened (e.g. no token work at all).
export function perfFirst(stage: string): number | undefined {
	return firsts.get(stage)
}

// Headline numbers the bench and the diagnosis read. Every value is ms since navigation start.
function summary(): Record<string, number> {
	const report: Record<string, number> = {}
	for (const stage of HEADLINE_STAGES) {
		// A stage that never ran is simply absent from the report.
		if (!firsts.has(stage)) continue
		report[stage] = Math.round(firsts.get(stage) ?? 0)
	}
	return report
}

// The stages a load report leads with: rows on screen, then the first and full colorization.
const HEADLINE_STAGES = [
	'module',
	'contents:loaded',
	'render:painted',
	'pool:boot:start',
	'pool:boot:done',
	'pool:job:open',
	'pool:window:sent',
	'pool:window:done',
	'pool:publish',
	'pool:publish:painted',
	'pool:final',
] as const

declare global {
	interface Window {
		synevaPerf?: typeof timeline | undefined
	}
}

const timeline = {
	// Live array: the bench reads it mid-flight, so it must not be a copy taken at install time.
	marks,
	snapshot: (): { marks: PerfMark[]; summary: Record<string, number> } => ({
		marks: [...marks],
		summary: summary(),
	}),
}

// Absent in Node, where the pool's unit tests import this module through their subject: the
// timeline is a browser diagnostic, so installing it is the only thing that needs a window.
if (typeof window !== 'undefined') window.synevaPerf = timeline

perfMark('module')
