import type { ReactElement } from 'react'

// React primitive for the icon sprite (shared/ui/icons.ts injects the symbols
// once at boot; `<use href="#gly-…">` resolves document-wide). Every icon keeps
// the base `ic` class; callers add their modifier classes on top.
export function Icon({
	id,
	className,
	title,
}: {
	id: string
	className?: string
	title?: string
}): ReactElement {
	const cls = ['ic', className].filter(Boolean).join(' ')
	return (
		<svg className={cls} aria-hidden={!title} title={title}>
			<use href={`#${id}`} />
		</svg>
	)
}
