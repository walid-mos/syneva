import { D } from '../store'

import type { Row } from '../cursor-rows'
import type { Side } from '../types'

export type LineAlignment = 'center' | 'nearest' | 'start'

export type DiffViewport = {
	afterPaint(): void
	rows(): Row[]
	reveal(
		side: Side,
		line: number,
		alignment: LineAlignment,
		offset?: number,
	): boolean
	position(
		side: Side,
		line: number,
	): { top: number; height: number } | undefined
}

// Features depend on logical rows and line positions, not on the library's window internals.
// Weak ownership lets cached/disposed instances disappear without a second cleanup registry.
const viewports = new WeakMap<object, DiffViewport>()

export function registerViewport(
	instance: object,
	viewport: DiffViewport,
): void {
	viewports.set(instance, viewport)
}

export function activeViewport(): DiffViewport | undefined {
	if (!D.instance) return undefined
	return viewports.get(D.instance)
}
