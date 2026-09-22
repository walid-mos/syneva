import {
	DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
	VirtualizedFileDiff,
	Virtualizer,
} from '@pierre/diffs'
import { registerViewport } from '@shared/diff-renderer/viewport'
import { virtualLines } from '@shared/diff-renderer/virtual-lines'
import { $ } from '@shared/lib/dom'

import { D } from './runtime'

import type { AnnotationMeta } from '@entities/review/annotations'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { Row } from '@shared/diff-renderer/cursor-rows'
import type { Side } from '@shared/diff-renderer/types'
import type { LineAlignment } from '@shared/diff-renderer/viewport'

const CENTER_FRACTION = 0.5
const STABLE_REVEAL_FRAMES = 2
const MAX_REVEAL_FRAMES = 12

// Render-range quantization: the pinned library mounts the window rounded up to whole chunks of
// hunkLineCount lines plus one spare chunk (its default 50 mounted 150 rows for a ~56-row window on
// the 8k-line fixture). 25 halves that to 75 rows, and with it every window change's cost (measured:
// render avg 5.1 ms → 2.7 ms, max 38 ms → 13 ms on the 200k-px fixture) - the cost that decides
// whether a fast scroll paints black while the main thread catches up. Checkpoints are laid out
// every 5000 rows (pinned constant), so the finer quantum only affects window sizing, not their
// accuracy; the token window plan (WINDOW_SLOTS) is independent of this knob.
const RENDER_CHUNK_LINES = 25
export { RENDER_CHUNK_LINES }
type LineReveal = {
	side: Side
	line: number
	alignment: LineAlignment
	offset: number
}

// The only subclass seam: expanded context belongs to the renderer. Reading its protected
// expansion map here keeps keyboard order consistent without mirroring expandHunk mutations.
export class VirtualDiff extends VirtualizedFileDiff<AnnotationMeta> {
	private logicalRows: Row[] = []
	private expansionKey = ''
	private headerHeight = 0
	// Row-height estimate we last handed to setMetrics (seeded from CSS, then calibrated). The
	// library's `metrics` is private, so this local mirror is what reconcileHeights restates.
	private rowEstimate: number | undefined
	private calibrated = false
	private requestedLine: LineReveal | undefined
	private revealFrame = 0
	private stableRevealFrames = 0
	private revealAttempts = 0

	afterPaint(): void {
		cancelAnimationFrame(this.revealFrame)
		this.revealFrame = requestAnimationFrame(() => {
			const requested = this.requestedLine
			if (!requested || D.instance !== this) return
			if (++this.revealAttempts > MAX_REVEAL_FRAMES) {
				this.requestedLine = undefined
				return
			}
			const host = $('diff')
			const before = host.scrollTop
			if (
				!this.scrollMountedLine(
					requested.side,
					requested.line,
					requested.alignment,
					requested.offset,
				)
			)
				return
			this.stableRevealFrames =
				Math.abs(host.scrollTop - before) < 1
					? this.stableRevealFrames + 1
					: 0
			if (this.stableRevealFrames >= STABLE_REVEAL_FRAMES)
				this.requestedLine = undefined
			else this.afterPaint()
		})
	}

	reveal(
		side: Side,
		line: number,
		alignment: LineAlignment,
		offset = 0,
	): boolean {
		const target = this.position(side, line)
		if (!target) return false
		this.requestedLine = { side, line, alignment, offset }
		this.stableRevealFrames = 0
		this.revealAttempts = 0
		this.afterPaint()
		if (this.scrollMountedLine(side, line, alignment, offset)) return true
		const host = $('diff')
		const bottom = target.top + target.height
		if (alignment === 'start') host.scrollTop = target.top - offset
		else if (alignment === 'center')
			host.scrollTop =
				target.top -
				(host.clientHeight - target.height) * CENTER_FRACTION
		else if (target.top < host.scrollTop) host.scrollTop = target.top
		else if (bottom > host.scrollTop + host.clientHeight)
			host.scrollTop = bottom - host.clientHeight
		return true
	}

	updateMetadata(metadata: FileDiffMetadata): void {
		// render() only adopts the first metadata object in the pinned library. Its public
		// layout-reset seam updates later decision replays while retaining expanded context.
		this.logicalRows = []
		this.updateCodeViewLayout(metadata, this.top ?? 0)
		this.rerender()
	}

	reconcileHeights(): boolean {
		const changed = super.reconcileHeights()
		// Simple Virtualizer ignores this method's boolean result. Re-arm it explicitly
		// or a newly measured wrap/thread can leave the pane stuck on an empty window.
		if (changed) this.rerender()
		this.calibrateLineHeight()
		const header = this.fileContainer?.querySelector<HTMLElement>('.ghdr')
		const height = header?.getBoundingClientRect().height ?? 0
		if (
			!height ||
			height === this.headerHeight ||
			!this.fileDiff ||
			!this.fileContainer
		)
			return changed
		this.headerHeight = height
		if (!this.rowEstimate) return changed
		this.setMetrics({
			diffHeaderHeight: height,
			// setMetrics merges the partial over the LIBRARY DEFAULTS, so every key we own must be
			// restated or it silently reverts (hunkLineCount would fall back to 50).
			hunkLineCount: RENDER_CHUNK_LINES,
			lineHeight: this.rowEstimate,
		})
		this.updateCodeViewLayout(this.fileDiff, this.top ?? 0)
		this.rerender()
		return true
	}

	// The estimate behind every UNMEASURED row (checkpoints, total height, window placement) is
	// metrics.lineHeight - initialized from the CSS line-height, which is one text box. In wrap mode
	// (the default) a row wraps to two boxes and measures 2× that, so every estimate starts 2× short:
	// the document grows by +20 px per measured row as the reviewer scrolls (measured +2 040 px on the
	// 8k-line fixture per sweep), shifting content under the scroll anchor - the black bands and jumps
	// of a fast scroll. Calibrate once per instance to the median height of the rows actually mounted
	// (the dominant wrap count of this file), then let per-row deltas handle the outliers. Once, not
	// per pass: a rolling recalibration would reset the measured deltas on every window whose median
	// drifts, thrashing the layout mid-scroll.
	//
	// Public: the library only invokes reconcileHeights on window changes, so left alone the
	// correction lands on the reviewer's first scroll tick - the whole document coordinate space
	// (still 1× short) inflates under the scroll anchor at once. diff-options' onPostRender calls
	// this one frame after mount, while scrollTop is still 0, so the estimate is already right
	// before any scrolling starts.
	calibrateLineHeight(): boolean {
		if (!this.fileContainer) return false
		if (!this.rowEstimate) {
			const cssLineHeight = Number.parseFloat(
				getComputedStyle(this.fileContainer).lineHeight,
			)
			if (!Number.isFinite(cssLineHeight)) return false
			this.rowEstimate = cssLineHeight
		}
		if (this.calibrated) return false
		const rows =
			this.fileContainer.shadowRoot?.querySelectorAll<HTMLElement>(
				'[data-line]',
			)
		if (!rows || rows.length < MIN_ROWS_FOR_CALIBRATION) return false
		const heights: number[] = []
		const sample = Math.min(rows.length, CALIBRATION_SAMPLE)
		for (let i = 0; i < sample; i++)
			heights.push(rows[i].getBoundingClientRect().height)
		heights.sort((a, b) => a - b)
		const median = heights[Math.floor(heights.length / MEDIAN_RANK)]
		this.calibrated = true
		if (!Number.isFinite(median) || median <= 0) return false
		if (Math.abs(median - this.rowEstimate) < 1) return false
		this.rowEstimate = median
		this.setMetrics({
			// Restate diffHeaderHeight/hunkLineCount: setMetrics merges over the LIBRARY DEFAULTS.
			diffHeaderHeight: this.headerHeight,
			hunkLineCount: RENDER_CHUNK_LINES,
			lineHeight: median,
		})
		if (this.fileDiff) {
			this.updateCodeViewLayout(this.fileDiff, this.top ?? 0)
			this.rerender()
		}
		return true
	}

	scrollMountedLine(
		side: Side,
		line: number,
		alignment: LineAlignment,
		offset = 0,
	): boolean {
		const indexes = this.getLineIndex(line, side)
		if (!indexes) return false
		const column =
			this.options.diffStyle === 'unified'
				? '[data-unified]'
				: `[data-${side}]`
		const row = this.fileContainer?.shadowRoot?.querySelector<HTMLElement>(
			`${column} [data-line][data-line-index="${indexes.join(',')}"]`,
		)
		if (!row) return false
		const host = $('diff')
		const box = row.getBoundingClientRect()
		const pane = host.getBoundingClientRect()
		if (alignment === 'start') host.scrollTop += box.top - pane.top - offset
		else if (alignment === 'center')
			host.scrollTop +=
				box.top -
				pane.top -
				(host.clientHeight - box.height) * CENTER_FRACTION
		else if (box.top < pane.top) host.scrollTop += box.top - pane.top
		else if (box.bottom > pane.bottom)
			host.scrollTop += box.bottom - pane.bottom
		return true
	}

	position(
		side: Side,
		line: number,
	): { top: number; height: number } | undefined {
		const location = this.getLinePosition(line, side)
		if (!location) return undefined
		return { top: (this.top ?? 0) + location.top, height: location.height }
	}

	// The pool's stream gate needs the slice on screen, but a cache-hit range (the renderCache
	// holds the full grid) serves rows without a plain fetch - so the render layer reports it
	// from the committed rows instead. The first row's addition index is the viewport start;
	// the mounted count is its length.
	renderedViewport(): { start: number; count: number } | undefined {
		const rows =
			this.fileContainer?.shadowRoot?.querySelectorAll('[data-line]')
		if (!rows?.length) return undefined
		const parts = rows[0]?.getAttribute('data-line-index')?.split(',') ?? []
		const start = Number(parts[0])
		if (!Number.isFinite(start)) return undefined
		return { start, count: rows.length }
	}

	rows(): Row[] {
		if (!this.fileDiff) return []
		const expanded = this.options.expandUnchanged
			? true
			: this.hunksRenderer.getExpandedHunksMap()
		const key = expanded === true ? 'all' : JSON.stringify([...expanded])
		if (key !== this.expansionKey || !this.logicalRows.length) {
			this.expansionKey = key
			this.logicalRows = virtualLines(this.fileDiff, {
				style: this.options.diffStyle ?? 'split',
				expanded,
				threshold:
					this.options.collapsedContextThreshold ??
					DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
			})
		}
		return this.logicalRows
	}
}

export function bindVirtualDiff(instance: VirtualDiff): void {
	registerViewport(instance, {
		rows: () => instance.rows(),
		position: (side, line) => instance.position(side, line),
		reveal: (side, line, alignment, offset) =>
			instance.reveal(side, line, alignment, offset),
		afterPaint: () => instance.afterPaint(),
	})
}

// Lookahead kept mounted beyond the viewport. The mount window is the viewport plus this margin, so
// a margin proportional to what the reviewer actually sees is the only form that fits every window.
// Half a pane (measured: the mount window's quantization spare already adds ~25 rows of lead per
// side at RENDER_CHUNK_LINES 25) leaves ≈660 px of painted runway per side on the 8k-line fixture -
// ~1.6 frames of a hard trackpad fling - while the calibrated line height and the finer chunk
// quantum keep the total mount at half of what the old viewport/3 + uncalibrated-estimate build
// mounted (150 rows → 75-100).
const OVERSCROLL_VIEWPORT_DIVISOR = 2

// Calibration needs a representative sample of mounted rows: below this the median is one or two
// rows' opinion, not the file's.
const MIN_ROWS_FOR_CALIBRATION = 8
const CALIBRATION_SAMPLE = 48
// Median of the sorted sample: for an even count this takes the upper middle, biasing the estimate
// toward the taller (more wrapped) rows - under-estimating scroll distance is the failure mode we
// are fixing.
const MEDIAN_RANK = 2

// One scroll observer for the active window. Disposing it when switching files also cancels
// queued work from an old file; detached instances must never run current-file decorators.
export function createVirtualizer(wrapper: HTMLElement): Virtualizer {
	const pane = $('diff')
	const virtualizer = new Virtualizer({
		overscrollSize: Math.round(
			pane.clientHeight / OVERSCROLL_VIEWPORT_DIVISOR,
		),
	})
	virtualizer.setup(pane, wrapper)
	return virtualizer
}
