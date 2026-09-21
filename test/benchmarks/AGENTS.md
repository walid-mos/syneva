# AGENTS.md — benchmarks

Read `README.md` in this directory first: it owns the run shape, the stage definitions, the fixture
commands, the dashboard's reading guide, and where the numbers may come from. This file holds only the
rules that keep the timeline comparable over time.

## Maintaining the timeline

- **Record every measured run, including the ones that killed a hypothesis.** A rejected variant gets
  its own `id` and a `note` that says it was rejected and why (`warm-early-medium` is the worked
  example: right idea, measured, reverted). Numbers that stay in a transcript are lost, and a milestone
  that hides its negative results cannot be trusted later.
- **One milestone per batch of changes**, added to `history.json`'s `milestones` with a `label` and a
  `note` stating the hypothesis and the measured verdict. Never retitle or renumber an existing one —
  the evolution chart reads them as history.
- **Never hand-edit a number** in `history.json`. Runs come from `--record` (idempotent by `id`), a
  wrong point leaves with `--forget`, and `--check` must pass before you finish.
- **Say which route measured the run.** Rows taken through `pi-frontend-check` carry stage marks only;
  the older `parallel-*` rows came from `test/benchmarks/browser-bench.mjs` (headful, never run it from an agent
  session — desktop focus) and add per-request timings. Only the shared stage marks compare across
  routes, so the `note` names the route and the caveat.
- **Report the spread, not the best run.** Two samples minimum per fixture before claiming a gain: the
  pool boot swings 131–476 ms on identical code under contention. A single-sample "win" is noise.
- **Don't re-optimize what is already flat**: merge, publish and open-diff are 0–3 ms. The cold open is
  CPU-bound, so rescheduling work (the pool boot included) only moves the paint — measure before moving
  anything again.
- **Keep the artifact reproducible**: `dashboard-template.html` must keep its
  `/*BENCH_DATA_START*/`/`/*BENCH_DATA_END*/` markers, and `test/benchmarks/dashboard.html` is regenerated
  and committed with the run that changed it.
