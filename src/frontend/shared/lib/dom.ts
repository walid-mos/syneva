// DOM lookup + visibility primitives shared by the chrome widgets and the imperative
// diff island. Every id comes from index.html (src/frontend/app), which ships with the
// bundle, so a missing element is a bug in the page rather than a runtime condition
// to branch on.
export function $(id: string): HTMLElement {
	const el = document.getElementById(id)
	if (!el) throw new Error(`missing element #${id}`)
	return el
}
export function show(e: Element): void {
	e.classList.add('show')
}
export function hide(e: Element): void {
	e.classList.remove('show')
}
