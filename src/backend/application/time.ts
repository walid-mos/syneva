// Wall-clock stamps are an application concern, not a domain rule: the domain's
// pure transformations receive timestamps as values. This is the one place the
// desk reads the clock (no injectable Clock port - a plain function call here).

export function nowIso(): string {
	return new Date().toISOString()
}
