// Escape the three HTML-significant characters. Callers pass text drawn from the review
// (paths, comment bodies, guide prose), so non-string scalars stringify predictably here.
const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
}

export function esc(s: string | number | boolean | null | undefined): string {
	return String(s ?? '').replace(/[&<>]/g, c => HTML_ESCAPES[c] ?? c)
}
