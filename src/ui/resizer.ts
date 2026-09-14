// Pane resizers (imperative - they tweak CSS vars directly). Each handle drags one sidebar width,
// clamped to a readable range; the widths live in CSS custom properties on :root, so every pane
// reflows from one write.
const LEFT_WIDTH_DEFAULT_PX = 280
const RIGHT_WIDTH_DEFAULT_PX = 320
const LEFT_WIDTH_RANGE = { min: 180, max: 520 }
const RIGHT_WIDTH_RANGE = { min: 220, max: 620 }

export function installPaneResizers(): void {
	for (const handle of document.querySelectorAll<HTMLElement>(
		'[data-resize]',
	)) {
		handle.addEventListener('pointerdown', event => {
			event.preventDefault()
			handle.classList.add('dragging')
			const side = handle.dataset.resize
			const startX = event.clientX
			const styles = getComputedStyle(document.documentElement)
			const startLeft =
				parseInt(styles.getPropertyValue('--left-width')) ||
				LEFT_WIDTH_DEFAULT_PX
			const startRight =
				parseInt(styles.getPropertyValue('--right-width')) ||
				RIGHT_WIDTH_DEFAULT_PX
			handle.setPointerCapture(event.pointerId)
			// The move/up handlers are per-drag closures over startX (not on the handle) so a
			// concurrent drag of the other handle can't read this one's origin.
			const onMove = (move: PointerEvent): void => {
				const delta = move.clientX - startX
				if (side === 'left')
					document.documentElement.style.setProperty(
						'--left-width',
						`${clamp(startLeft + delta, LEFT_WIDTH_RANGE)}px`,
					)
				else
					document.documentElement.style.setProperty(
						'--right-width',
						`${clamp(startRight - delta, RIGHT_WIDTH_RANGE)}px`,
					)
			}
			const onUp = (): void => {
				handle.classList.remove('dragging')
				handle.removeEventListener('pointermove', onMove)
				handle.removeEventListener('pointerup', onUp)
			}
			handle.addEventListener('pointermove', onMove)
			handle.addEventListener('pointerup', onUp)
		})
	}
}

function clamp(width: number, range: { min: number; max: number }): number {
	return Math.max(range.min, Math.min(range.max, width))
}
