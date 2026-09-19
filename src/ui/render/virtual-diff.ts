import {
	DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
	VirtualizedFileDiff,
	Virtualizer,
} from '@pierre/diffs'

import { $, D } from '../store'

import { registerViewport } from './viewport'
import { virtualLines } from './virtual-lines'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { Row } from '../cursor-rows'
import type { AnnotationMeta, Side } from '../types'
import type { LineAlignment } from './viewport'

const CENTER_FRACTION = 0.5
const STABLE_REVEAL_FRAMES = 2
const MAX_REVEAL_FRAMES = 12
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
		this.prepareCodeViewItem(metadata, this.top ?? 0)
		this.rerender()
	}

	reconcileHeights(): boolean {
		const changed = super.reconcileHeights()
		// Simple Virtualizer ignores this method's boolean result. Re-arm it explicitly
		// or a newly measured wrap/thread can leave the pane stuck on an empty window.
		if (changed) this.rerender()
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
		const codeLine =
			this.fileContainer.shadowRoot?.querySelector('[data-line]')
		const lineHeight = Number.parseFloat(
			getComputedStyle(codeLine ?? this.fileContainer).lineHeight,
		)
		if (!Number.isFinite(lineHeight)) return changed
		this.setMetrics({ diffHeaderHeight: height, lineHeight })
		this.prepareCodeViewItem(this.fileDiff, this.top ?? 0)
		this.rerender()
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

// Lookahead kept mounted beyond the viewport: a third of the visible height on each side. The mount
// window is the viewport plus this margin, so a margin proportional to what the reviewer actually sees
// is the only form that fits every window - a third of a screen is ≈ a dozen rows at our line height,
// enough for a fast scroll to land on painted rows. The fixed 600px it replaces was ≈ a screen on a
// short window: measured there at ~10 500 shadow nodes for the first paint of a dense 400-line file,
// twice the visible band.
const OVERSCROLL_VIEWPORT_DIVISOR = 3

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
