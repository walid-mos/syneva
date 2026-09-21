# Benchmarks

The frontend perf history of this repo, as data: `history.json` holds every measured run, the
dashboard template renders it, and the generator produces a single self-contained HTML file.

```bash
node test/benchmarks/bench-dashboard.mjs            # test/benchmarks/dashboard.html (in-repo, commit it)
node test/benchmarks/bench-dashboard.mjs --check    # validate history + template, write nothing
node test/benchmarks/bench-dashboard.mjs --out ~/Desktop/syneva-perf.html   # personal copy
```

Maintenance rules for agents live next door in `AGENTS.md`; this file owns the shapes below.

## Recording a run

```bash
node test/benchmarks/bench-dashboard.mjs --record /tmp/run.json   # or "-" to read stdin
```

Recording is idempotent by `id`: re-recording the same id replaces that run in place, so a
corrected measurement never leaves a duplicate point in the evolution chart.

A run is one JSON object. Every key below is required; `windows`, `longTasks`, `spans`,
`perRowMs`, `perWindowFixedMs` and `note` are optional.

```json
{
	"id": "g-medium",
	"fixture": "medium",
	"milestone": "g",
	"date": "2026-09-17",
	"stagesMs": {
		"module": 29, "contents": 164, "plainPaint": 212,
		"bootStart": 179, "bootDone": 320, "jobOpen": 343,
		"firstWindowSent": 344, "firstColor": 772, "final": 1390
	},
	"pool": { "boots": 1, "workers": 4, "windowSent": 7, "windowDone": 7 },
	"workerBundleKb": 539,
	"longTasks": [{ "start": 335, "ms": 359, "label": "renderer row layout" }],
	"windows": [{ "kind": "sweep", "line": 0, "rows": 50, "tokenizeMs": 230.5 }]
}
```

One schema wart, worth knowing before you record: `contents` is the only stage stored as a
*duration* (the `/api/file-contents` transfer, measured by `test/benchmarks/browser-bench.mjs` from the
resource-timing entry) rather than a timestamp from navigation start like every other stage. The
waterfall reads it as the cost of that fetch.

`stagesMs` is the cold-open timeline of the UI, in ms from navigation start: `module` (script
evaluation), `contents` (first file's diff parsed), `plainPaint` (uncolored rows visible),
`bootStart`/`bootDone` (token pool), `jobOpen`, `firstWindowSent`, `firstColor` (the metric that
matters: colored rows on screen), `final` (whole file tokenized). `ttcStart` is optional and marks
the interaction that starts the reviewer's own clock - a file-row click on the switch fixtures, the
oversized-guard dismissal on `bigfile` - still in ms from navigation start, so it sits in the same
waterfall. TTC (time to colour, the reviewer-perceived wait) is derived, never stored:
`firstColor − ttcStart`; a pure cold open has no interaction to clock from and omits `ttcStart`, so
it has no TTC. `pool.windowSent` vs `windowDone` is the duplicate-dispatch check; `boots` is the
pool-boot-idempotency check.

## Reading the dashboard

The generated `test/benchmarks/dashboard.html` is committed: it is the same artifact a reviewer opens
without re-rendering it, so regenerate and commit it in the same change as the run it shows.

It is interactive, and every affordance is meant to answer a question rather than decorate:

- **Evolution chart** — hover (or Tab to) a point for its tooltip: run id, date, milestone, fixture,
  first colour, the signed delta against the previous run of the same fixture, worker bundle and pool
  boots. `←`/`→` walk that fixture's series, `Enter`/`Space` selects the run, `Esc` clears. Selecting a
  run drives the waterfall and the window table.
- **Legend chips** — click a fixture to hide its series (the axis rescales to what is visible); the
  last visible one cannot be hidden.
- **Waterfall** — hovering a bar shows its span (start → end, duration, share of the axis); the readout
  that follows the pointer gives the millisecond under the cursor; clicking a bar or a segment table row
  pins it, and the two highlight each other.
- **Window rows** — hovering shows rows, tokenize ms, ms/row (with the formula), share of the run total
  (with the formula) and whether it was a first-touch window.
- **Run table rows** — hovering lights that run's chart point and dims the others; clicking selects it.
- **Compare** — the per-stage delta table between two runs (default: baseline vs the selected one),
  with `—` and a "lacks this stage" note wherever one side has no measurement.

The state lives in the URL hash (`#run=…&fix=…&stage=…&cmp=a,b`), so a specific view can be linked or
reloaded; nothing is estimated — a derived number says its formula, and an unmeasured one shows `—`.

## Where the numbers come from

Measure through the `pi-frontend-check` tools (`frontend_open` then `frontend_eval` on
`window.synevaPerf.snapshot()`), never with a standalone headed browser. Fixtures:
`node test/benchmarks/bench-fixtures.mjs` → `/tmp/syneva-bench/repos/{tiny,small,medium,large,bigfile,patho}`.
A cold open means a fresh desk (`rm -rf <repo>/.syneva-review`, new `--session`) and a fresh
`frontend_open`.

## Measuring a file switch

The metric a reviewer feels is *click on a file → coloured rows*, and it is not a cold open: start the
clock at the click, on a live desk, with a real click on a tree row.

```js
// frontend_eval, after frontend_open on the desk under test
const snap = () => window.synevaPerf.snapshot()
const row = n => [...document.querySelectorAll('.nm')]
  .find(e => e.textContent.trim() === n)?.closest('div,li,button,a')
// wait for the previous file's job to settle if you want the idle-pool case
const idx = snap().marks.length, t0 = performance.now()
row('module-core-21.ts').click()
// attribute the publish to the NEW job: every pool mark carries the job key (`detail.key`), so a
// publish of the outgoing job (or of the NEXT file's prefetch, which shares its plan shape) cannot be
// mistaken for the clicked file's - matching on `windows` alone is what used to make that ambiguous.
```

Read back: click→`render:paint` (mount), click→first `pool:publish` **for the clicked file's key**
(first colour), `pool:window:sent` and `pool:window:done` grouped by key (the clicked file's own plan vs
whatever the pool dispatched for the next file's prefetch), and the tokenize spent before the colour.
`element.click()` reaches the real `@click` handler; synthetic **keyboard** events do not drive the
render path - do not use them.

Reference numbers (2026-09-18, `medium` desk, 400-line files, 8-window plans at the pool's
hardware-derived width - 5 on the 6-core bench): click→mount 329 ms, click→first colour 470-478 ms
with an idle pool and ~300 ms of tokenize before the colour. On `bigfile` with the 8000-line file's job
in flight, a switch to a 200-line file coloured in 255-266 ms while the abandoned file was still handing
out work - the number that moved with the `switch` milestone is how much of that work the pool still
dispatches: 29 windows (~26 s of tokenize) before, 0 after. The next file's prefetch is what shortens the
reviewer's own wait: clicking the prefetched next file coloured in 360-375 ms with 0 windows left to send
(its band was already merged), against 519 ms for the same build's cold control - a click on a file the
pass before it had not warmed.

`window.synevaPerf` (see `src/ui/perf.ts`) keeps the timeline: `snapshot()` gives the per-stage
first-occurrence summary, and `marks` carries one entry per event, including per-window worker
timings (`pool:window:done` → `rows`, `slice`, `tokenize`).

`test/benchmarks/browser-bench.mjs` is the older headful latency bench (scroll smoothness, memory). It is
not the source of `stagesMs`: prefer the `synevaPerf` timeline, and record its numbers here.
