import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } from '@pierre/diffs'
import { virtualLines } from '@shared/diff-renderer/virtual-lines'
import { $ } from '@shared/lib/dom'
import { perfSpan } from '@shared/lib/perf'

import { diffCtx } from './context'
import { preparePoolViewport } from './worker-pool'

import type { AnnotationMeta } from '@entities/review/annotations'
import type { FileDiffMetadata, FileDiffOptions } from '@pierre/diffs'
import type { WindowViewport } from '@shared/diff-renderer/token-pool/windows'

const INITIAL_COLOR_BUDGET_MS = 150

// Before @pierre mounts, approximate the rows its first window will emit from the
// already-parsed metadata. Dividing by font size (not the 1.62 line-height) gives
// a built-in ~1.6x overscan for wrapping and header/measurement drift.
function openingViewport(
	diff: FileDiffMetadata,
	options: FileDiffOptions<AnnotationMeta, undefined>,
): WindowViewport | undefined {
	const fontSize = Math.max(1, diffCtx().S.settings.fontSize)
	const rowBudget = Math.max(1, Math.ceil($('diff').clientHeight / fontSize))
	const rows = virtualLines(diff, {
		style: options.diffStyle ?? 'split',
		expanded: options.expandUnchanged ? true : new Map(),
		threshold:
			options.collapsedContextThreshold ??
			DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
	}).slice(0, rowBudget)
	const [first] = rows
	if (!first) return undefined
	const startingLine = Math.max(0, first.line - 1)
	const farthestLine = Math.max(...rows.map(row => row.line))
	return {
		startingLine,
		totalLines: Math.max(1, farthestLine - startingLine),
	}
}

// Gate only the first real diff paint. Giant cold files keep their immediate
// plain placeholder while metadata parses; once metadata exists, this bounded
// window is colored before the island replaces the placeholder/outgoing file.
export async function prepareInitialPaint(
	diff: FileDiffMetadata,
	options: FileDiffOptions<AnnotationMeta, undefined>,
): Promise<boolean> {
	const viewport = openingViewport(diff, options)
	if (!viewport) return false
	const endSpan = perfSpan('render:tokens:prepare')
	const isReady = await withinFirstPaintBudget(
		preparePoolViewport(diff, viewport),
	)
	endSpan({ ready: isReady, lines: viewport.totalLines })
	return isReady
}

// Unequal giant change groups stay atomic to preserve @pierre's line pairing.
// They may miss the budget; paint plain rather than letting token work block the
// first real diff indefinitely, then use the pool's normal highlighted flip.
async function withinFirstPaintBudget(
	preparation: Promise<boolean>,
): Promise<boolean> {
	let timeout: number | undefined
	const budget = new Promise<boolean>(resolve => {
		timeout = window.setTimeout(
			() => resolve(false),
			INITIAL_COLOR_BUDGET_MS,
		)
	})
	const isReady = await Promise.race([preparation, budget])
	if (timeout) window.clearTimeout(timeout)
	return isReady
}
