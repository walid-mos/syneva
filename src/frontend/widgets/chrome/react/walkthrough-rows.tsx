import { varStyle } from '@shared/lib/var-style'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import type { WalkRow } from '@entities/review/guide/walkthrough'
import type { ReactElement } from 'react'

// The walkthrough pane rows: category headers (with the two trailing fold groups): category headers (with the two trailing fold groups)
// and per-file rows (status icon leads, +/- flush right). Rows come pre-classed
// from walkRows(), which derives the active highlight from the active path.

// The +/- glyph pair matches the diff's churn indicators; U+2212 is the minus the
// CSS width was tuned against, written as an escape to keep comparisons ASCII-safe.
const REMOVED_GLYPH = '\u2212'

function WalkStateIcon({ state }: { state: string }): ReactElement {
	const icons: Record<string, { id: string; title: string }> = {
		pending: { id: 'gly-circle', title: 'Pending review' },
		approved: { id: 'gly-check', title: 'Approved' },
		'changes-requested': {
			id: 'gly-circle-alert',
			title: 'Changes requested',
		},
	}
	const icon = icons[state]
	if (!icon) return <></>
	return <Icon id={icon.id} className={`st ${state}`} title={icon.title} />
}

function WalkLineStats({
	added,
	removed,
}: {
	added: number
	removed: number
}): ReactElement {
	// Hidden on cat rows: an empty status-pack still carries margin-left:auto, and two
	// auto margins would split the free space and strand the fold-group count mid-row.
	return (
		<span className="status-pack">
			{added ? <i className="add">{`+${added}`}</i> : null}
			{removed ? (
				<i className="del">{`${REMOVED_GLYPH}${removed}`}</i>
			) : null}
		</span>
	)
}

function WalkCatNode(row: Extract<WalkRow, { kind: 'cat' }>): ReactElement {
	const { S } = chromeCtx()
	const foldable = row.renamed || row.reviewed
	return (
		<div
			className={`node walk-cat${foldable ? ' walk-fold' : ''}`}
			data-key={row.key}
			onClick={() => {
				if (row.renamed) S.toggleRenamedGroup?.()
				else if (row.reviewed) S.toggleReviewedGroup?.()
				else S.selectFile?.(row.jumpIndex)
			}}
		>
			{foldable && (
				<Icon
					id="gly-chevron"
					className={row.open ? 'chev open' : 'chev'}
				/>
			)}
			<span className="nm walk-cat-name" title={row.category}>
				{row.category}
			</span>
			{foldable && (
				<span className="walk-fold-count">
					{row.total + (row.total === 1 ? ' file' : ' files')}
				</span>
			)}
		</div>
	)
}

function MovedFrom({ from }: { from: string }): ReactElement {
	return (
		<span
			className="moved-from"
			title={`moved from ${from}`}
		>{`← ${from}`}</span>
	)
}

function WalkFileNode(row: Extract<WalkRow, { kind: 'file' }>): ReactElement {
	return (
		<div
			className={`node ${row.cls}`}
			data-key={row.key}
			style={varStyle(row.style)}
			onClick={() => chromeCtx().S.selectFile?.(row.fileIndex)}
		>
			{/* File status leads the row (empty circle = to do); ± stay flush right below. */}
			<WalkStateIcon state={row.state} />
			<span className="nm" title={row.path}>
				{row.name}
			</span>
			{row.movedFrom && <MovedFrom from={row.movedFrom} />}
			<WalkLineStats added={row.added} removed={row.removed} />
		</div>
	)
}

export function WalkNode({ row }: { row: WalkRow }): ReactElement {
	return row.kind === 'cat' ? (
		<WalkCatNode row={row} />
	) : (
		<WalkFileNode row={row} />
	)
}
