// Icon sprite for the file tree + status badges. Bodies are inlined from an Iconify set (see
// scripts/fetch-icons.mjs / icon-data.ts) so the app stays zero-runtime-dep. Icons use
// currentColor - each inherits its row's color; the duotone sets layer a full + an opacity-.5
// path for depth. Injected once so `<use href="#gly-…">` resolves anywhere in the document.
import { ICON_DATA } from './icon-data'

const iconSymbols = Object.entries(ICON_DATA)
	.map(
		([id, { vb, body }]) =>
			`<symbol id="${id}" viewBox="${vb}">${body}</symbol>`,
	)
	.join('')

export const ICON_SPRITE = `<svg data-galley-icons aria-hidden="true" width="0" height="0" style="position:absolute">${iconSymbols}</svg>`

let hasInjected = false
export function ensureIcons(): void {
	if (hasInjected) return
	const holder = document.createElement('div')
	holder.innerHTML = ICON_SPRITE
	const svg = holder.firstElementChild
	if (svg) document.body.appendChild(svg)
	hasInjected = true
}
