// Inline CSS custom-property strings ("--depth:12") as React style objects.
// The row models carry Alpine-era single-var strings; React's style prop needs
// the object form, so the one var format is parsed here.
import type { CSSProperties } from 'react'

export function varStyle(spec: string): CSSProperties {
	const [name, value] = spec.split(':')
	return { [name]: value }
}
