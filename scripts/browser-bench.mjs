// Browser bench: cold open, interaction latencies, scroll smoothness, and memory across
// the fixture repos scripts/bench-fixtures.mjs builds. Driver: playwright + chromium,
// HEADFUL - headless-shell throttles requestAnimationFrame (~1fps), which would turn every
// latency into a throttle artifact.
//
// Prereqs (not in devDependencies; the bench is a local perf tool, not part of CI):
//   node scripts/bench-fixtures.mjs
//   npm i playwright@~1.63  # in any scratch dir, or: pnpm dlx playwright@1.63 install chromium
//   pnpm build
//   node scripts/browser-bench.mjs [repo ...]   # default: every fixture
//
// Output: one result-browser-<repo>.json per repo, plus a summary line per repo on stdout.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const REPO_ROOT = path.join('/tmp', 'syneva-bench', 'repos')
// The bench redirects HOME (desk state isolation). Pin playwright's browser cache to the
// user's real one before the redirect, or every launch would look in the tmp home first.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.HOME)
	process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
		process.env.HOME,
		'Library',
		'Caches',
		'ms-playwright',
	)

const median = xs =>
	xs.length ? xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] : 0
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Boot helper: fresh syneva desk per repo/session (ports are `--port 0` randomized).
// HOME is redirected so the desk's persisted review files never touch the user's state.
async function spawnDesk(repo, session, env) {
	const CLI = path.join(process.cwd(), 'dist', 'cli.js')
	const { spawn } = await import('node:child_process')
	const desk = spawn(
		'node',
		[CLI, '--repo', repo, '--session', session, '--port', '0', '--no-open'],
		{ stdio: ['ignore', 'ignore', 'pipe'], env },
	)
	const url = await new Promise(resolve => {
		let buf = ''
		const onData = d => {
			buf += String(d)
			const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/)
			if (m) {
				desk.stderr.off('data', onData)
				resolve(m[0])
			}
		}
		desk.stderr.on('data', onData)
		setTimeout(() => resolve(undefined), 60_000)
	})
	return { desk, url }
}

// Instrumentation injected before the desk boots: MutationObserver timestamps, longtask
// census, Chrome LoAF script attribution, rAF gap census, and a fetch hook the latency
// battery anchors on (keydown -> relevant api response end -> second following rAF).
const INIT = `(() => {
  window.__bench = { muts: [], longtasks: [], glyphs: [], loaf: [], net: [], wlog: [] }
  const push = (arr, v) => { if (arr.length < 5000) arr.push(v) }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        push(window.__bench.longtasks, { t: Math.round(e.startTime), d: Math.round(e.duration) })
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        for (const s of (e.scripts ?? []))
          push(window.__bench.loaf, {
            d: Math.round(s.duration),
            name: (s.functionName || '').slice(0, 90),
            src: (s.sourceURL || '').split('/').at(-1),
          })
    }).observe({ entryTypes: ['long-animation-frame'] })
  } catch {}
  const rawFetch = window.fetch.bind(window)
  window.fetch = (...args) =>
    rawFetch(...args).then((r) => {
      push(window.__bench.net, { end: performance.now(), url: String(args[0]).split('?')[0] })
      return r
    })
  // Worker census: postMessage traffic per desk boot (init acks + diff/file task results).
  const OW = window.Worker
  if (OW) {
    window.Worker = class extends OW {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', (e) => {
          if (window.__bench.wlog.length < 900)
            push(window.__bench.wlog, {
              t: performance.now(),
              type: e.data?.requestType,
              id: e.data?.id,
              kind: e.data?.result ? 'result' : 'ack',
            })
        })
      }
    }
  }
  window.__bench.waitPaint = (base, wantUrl) =>
    new Promise((resolve) => {
      let anchor = base
      for (const n of window.__bench.net) {
        const requestUrl = n.url
        if ((!wantUrl || requestUrl.includes(wantUrl)) && n.end > base - 1)
          anchor = Math.max(anchor, n.end)
      }
      let frames = 0
      const tick2 = () => {
        frames++
        if (frames >= 2) resolve(Math.round(performance.now() - anchor))
        else requestAnimationFrame(tick2)
      }
      requestAnimationFrame(tick2)
    })
  let prev = performance.now()
  const tick = () => {
    const now = performance.now()
    push(window.__bench.glyphs, now - prev)
    prev = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const ROWS_P = `(() => {
  const shadow = document.getElementById('diff')?.querySelector('diffs-container')?.shadowRoot
  return !!shadow && shadow.querySelectorAll('[data-line-number-content]').length > 0
})()`

async function benchRepo(name) {
	const HOME = mkdtempSync(path.join(tmpdir(), 'syneva-bench-home-'))
	process.env.HOME = HOME
	process.env.SYNEVA_NO_UPDATE_CHECK = '1'

	const session = `bench-${name}`
	const { desk, url } = await spawnDesk(
		path.join(REPO_ROOT, name),
		session,
		process.env,
	)
	if (!url) {
		desk.kill('SIGKILL')
		throw new Error(`desk for ${session} never announced a URL`)
	}
	let playwright
	try {
		// Resolve from the CWD first (the bench is often run from a scratch dir where
		// playwright is installed), then from this script's own module graph.
		const { createRequire } = await import('node:module')
		const { pathToFileURL } = await import('node:url')
		const req = createRequire(path.join(process.cwd(), 'bench.cjs'))
		playwright = await import(pathToFileURL(req.resolve('playwright')).href)
	} catch {
		throw new Error(
			'the browser bench needs playwright: `npm i playwright@~1.63` in a scratch dir, then `npx playwright install chromium`',
		)
	}
	const browser = await (playwright.default ?? playwright).chromium.launch({
		headless: false,
	})
	const page = await browser.newPage()
	await page.addInitScript(INIT)

	// ── cold open ──────────────────────────────────────────────────────────────
	// The opening file may be oversized: the desk paints a summary card ("Load diff anyway")
	// instead of rows. Accept either surface; when the card shows, drive Enter and measure
	// the card and the real rows separately.
	const navStart = Date.now()
	await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
	const surface = await page
		.waitForFunction(
			() => {
				const shadow = document
					.getElementById('diff')
					?.querySelector('diffs-container')?.shadowRoot
				if (
					shadow &&
					shadow.querySelectorAll('[data-line-number-content]')
						.length > 0
				)
					return 'rows'
				return document.body.innerText.includes('Load diff anyway')
					? 'card'
					: null
			},
			undefined,
			{ timeout: 120_000, polling: 50 },
		)
		.then(h => h.jsonValue())
	const timeToSurface = Date.now() - navStart
	let oversizeLoadMs = -1
	if (surface === 'card') {
		const t0 = Date.now()
		await page.keyboard.press('Enter')
		await page.waitForFunction(ROWS_P, undefined, {
			timeout: 120_000,
			polling: 25,
		})
		oversizeLoadMs = Date.now() - t0
	}
	await page.waitForFunction(ROWS_P, undefined, {
		timeout: 120_000,
		polling: 25,
	})
	const timeToRows = Date.now() - navStart
	await page
		.waitForFunction(
			() => {
				const shadow = document
					.getElementById('diff')
					?.querySelector('diffs-container')?.shadowRoot
				return (
					!!shadow &&
					shadow.querySelectorAll('code [style*="--diffs-token-"]')
						.length > 0
				)
			},
			undefined,
			{ timeout: 180_000, polling: 100 },
		)
		.catch(() => {})
	const timeToTokens = Date.now() - navStart
	// Windowed pool: fully colored = every token window for this open landed (the token-task
	// log stops producing new results for a beat). Falls through when the SIZE flag made the
	// pool take no work (page heavy-file stamp: the wlog just stays init-only).
	const timeToFullyColored = await page
		.waitForFunction(
			() => {
				const tasks = window.__bench.wlog.filter(
					entry => entry.type === 'token-window',
				)
				if (tasks.length < 2) return true
				const last = tasks.at(-1)
				return (
					last.kind === 'result' && performance.now() - last.t > 700
				)
			},
			undefined,
			{ timeout: 240_000, polling: 120 },
		)
		.then(() => Date.now() - navStart)
		.catch(() => -1)
	await sleep(1500)

	// Network + parse census for the state payload (large desks: one sample only - refetching
	// a >40MB payload three times would blow the tab's heap).
	const cold = await page.evaluate(async () => {
		// payload executes in the tab (performance/resource entries live there) - the
		// scoping rule cannot see the evaluate boundary.
		// oxlint-disable-next-line unicorn/consistent-function-scoping
		const payload = async p => {
			const s = performance.now()
			const r = await fetch(p)
			const text = await r.text()
			const transferMs = performance.now() - s
			const sp = performance.now()
			JSON.parse(text)
			return {
				ms: Math.round(transferMs),
				bytes: text.length,
				parseMs: Math.round(performance.now() - sp),
			}
		}
		const first = await payload('/api/state')
		const samples =
			first.bytes > 40_000_000
				? [first]
				: [
						first,
						await payload('/api/state'),
						await payload('/api/state'),
					]
		const [state] = samples.toSorted((a, b) => a.ms - b.ms)
		const fc = performance
			.getEntriesByType('resource')
			.findLast(e => e.name.includes('file-contents'))
		const ui = performance
			.getEntriesByType('resource')
			.findLast(e => e.name.includes('ui.js'))
		return {
			stateMs: state.ms,
			stateBytes: state.bytes,
			stateParseMs: state.parseMs,
			contentsMs: Math.round(fc?.duration ?? 0),
			contentsBytes: Number(fc?.decodedBodySize ?? 0),
			uiMs: Math.round(ui?.duration ?? 0),
			uiBytes: Number(ui?.decodedBodySize ?? 0),
		}
	})

	// ── interaction latency battery ────────────────────────────────────────────
	// Keypress → settle latency: waitPaint resolves on the second rAF after the relevant
	// response (/api/decide, /api/file-contents) or after the keypress when nothing posts.
	async function keyLatency(key, wantUrl, samples = 3, settle = 350) {
		const lat = []
		for (let i = 0; i < samples; i++) {
			const base = await page.evaluate(() => performance.now())
			await page.keyboard.press(key)
			const ms = await page.evaluate(
				([b, want]) => window.__bench.waitPaint(b, want),
				[base, wantUrl],
			)
			lat.push(ms)
			await sleep(settle)
		}
		return median(lat)
	}

	const acceptMs = await keyLatency('Shift+KeyY', '/api/decide')
	const viewToggleMs = await keyLatency('KeyV', null)

	const nextFileMs = []
	for (let i = 0; i < 6; i++) {
		const base = await page.evaluate(() => performance.now())
		await page.keyboard.press('Shift+ArrowRight')
		const ms = await page.evaluate(
			([b, want]) => window.__bench.waitPaint(b, want),
			[base, '/api/file-contents'],
		)
		nextFileMs.push(ms)
		await sleep(350)
	}
	// Warm revisit: one file back - the metadata memo + instance cache should be warm.
	const revisitMs = await keyLatency('Shift+ArrowLeft', null, 2, 150)

	// ── scroll smoothness ──────────────────────────────────────────────────────
	await page.mouse.move(320, 400)
	await page.mouse.wheel(0, 1500)
	await sleep(200)
	await page.mouse.wheel(0, 1500)
	await sleep(400)
	const scroll = await page.evaluate(() => {
		const tail = window.__bench.glyphs.slice(-500)
		return {
			droppedFrames: tail.filter(g => g > 48).length,
			maxFrameGap: Math.max(0, ...tail.map(g => Math.round(g))),
		}
	})

	// ── memory: open baseline vs after browsing past the cache cap ────────────
	const cdp = await page.context().newCDPSession(page)
	await cdp.send('Performance.enable')
	const heap = async () =>
		(await cdp.send('Performance.getMetrics')).metrics.find(
			m => m.name === 'JSHeapUsedSize',
		)?.value ?? 0
	const heapOpen = await heap()
	const churn = name === 'large' ? 12 : 34
	for (let i = 0; i < churn; i++) {
		await page.keyboard.press('Shift+ArrowRight')
		await sleep(120)
	}
	await sleep(4000)
	const heapChurn = await heap()

	// ── census + LoAF attribution ──────────────────────────────────────────────
	const loaf = await page.evaluate(() => {
		const agg = new Map()
		for (const s of window.__bench.loaf) {
			const key = `${s.name.length > 0 ? s.name : '?'} @ ${s.src.length > 0 ? s.src : '?'}`
			agg.set(key, (agg.get(key) ?? 0) + Number(s.d))
		}
		return [...agg.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 12)
	})
	const wlog = await page.evaluate(() => window.__bench.wlog.slice(-30))
	const longtasks = await page.evaluate(() => {
		const ds = window.__bench.longtasks.map(l => l.d)
		return {
			allCount: ds.length,
			allMax: Math.max(0, ...ds),
			over200: ds.filter(x => x > 200).length,
		}
	})

	const out = {
		coldOpen: {
			timeToSurface,
			surface,
			oversizeLoadMs,
			timeToRows,
			timeToTokens: timeToFullyColored > 0 ? timeToTokens : timeToTokens,
			fullyColoredMs: timeToFullyColored,
		},
		cold,
		interaction: {
			acceptMs,
			viewToggleMs,
			nextFileMs: median(nextFileMs.filter(x => x > 0)),
			revisitMs,
		},
		scroll,
		memoryMb: {
			afterOpen: Math.round(heapOpen / 1e6),
			afterBrowsing: Math.round(heapChurn / 1e6),
		},
		longtasks,
		loafTopMs: loaf,
		workerTasks: wlog,
	}
	writeFileSync(
		path.join(process.cwd(), `.bench-${name}.json`),
		JSON.stringify(out, null, 2),
	)
	const line = [
		name,
		`rows=${timeToRows}ms`,
		`tokens=${timeToTokens}ms`,
		`fullyColored=${out.coldOpen.fullyColoredMs}ms`,
		`accept=${acceptMs}ms`,
		`nextFile=${out.interaction.nextFileMs}ms`,
		`revisit=${revisitMs}ms`,
		`state=${Math.round(out.cold.stateBytes / 1024)}KB`,
		`mem=${out.memoryMb.afterOpen}->${out.memoryMb.afterBrowsing}MB`,
	].join('  ')
	console.log(line)
	desk.kill('SIGKILL')
	await browser.close()
	return out
}

const onlyAll = process.argv.slice(2)
const REPOS = onlyAll.length
	? onlyAll
	: ['tiny', 'small', 'medium', 'bigfile', 'patho', 'large']
const results = {}
for (const name of REPOS) {
	try {
		results[name] = await benchRepo(name)
	} catch (e) {
		results[name] = { error: String(e).slice(0, 200) }
		console.log(name, 'FAILED', String(e).slice(0, 140))
	}
}
writeFileSync(
	path.join(process.cwd(), 'browser-bench-results.json'),
	JSON.stringify(results, null, 2),
)
console.log('bench written: browser-bench-results.json')
