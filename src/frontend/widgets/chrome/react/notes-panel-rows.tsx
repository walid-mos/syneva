import { chromeCtx } from '../context'

import type { ReviewNote } from '@entities/review/notes'
import type { ReactElement } from 'react'

// The notes panel's row layer: one thread row (status, where, body, the agent's reply
// on an answered question), the per-file sections it groups into, and the two full-bleed
// empty states. Pure presentation - the visible list itself is derived by notesPanelView
// in @entities/review/notes and shared with the cursor logic in the facade.

function statusLabel(note: ReviewNote): string {
	if (note.status === 'resolved') return 'resolved'
	if (note.status === 'answered') return 'answered'
	return note.kind === 'question' ? 'waiting' : 'open'
}

function whereLabel(note: ReviewNote): string {
	if (note.fileLevel) return 'file'
	const end = note.endLine && note.endLine !== note.lineNumber
	return `line ${note.lineNumber}${end ? `\u2013${note.endLine}` : ''}`
}

export function NoteRow({
	note,
	index,
	current,
}: {
	note: ReviewNote
	index: number
	current: boolean
}): ReactElement {
	const { S } = chromeCtx()
	const cursor = index === S.notesCursor
	return (
		<button
			className={`note${note.status === 'resolved' ? ' resolved' : ''}${
				cursor ? ' cursor' : ''
			}`}
			data-status={note.status}
			data-cursor={cursor || undefined}
			data-current={current || undefined}
			onClick={() => {
				// Click and cursor stay one state: landing on a row moves the cursor onto it.
				S.notesCursor = index
				S.jumpToNote?.(note)
			}}
		>
			<span className="note-top">
				<span className="note-where">{whereLabel(note)}</span>
				{note.unanchored && (
					<span className="note-flag">lost place</span>
				)}
				<span className={`note-status ${note.status}`}>
					{statusLabel(note)}
				</span>
			</span>
			<span className="note-body">{note.preview}</span>
			{note.kind === 'question' &&
				note.status === 'answered' &&
				note.latest && (
					<span className="note-reply">{note.latest}</span>
				)}
		</button>
	)
}

// Consecutive same-path notes become one file group; the cursor index keeps running ACROSS
// groups - it is the section's slice of the panel's flat visible rows (questions then
// comments; startIndex is where this section begins), so a restart per file would give
// several rows the same index and scramble the cursor.
function groupByFile(
	notes: ReviewNote[],
	startIndex: number,
): { path: string; rows: { note: ReviewNote; index: number }[] }[] {
	const groups: { path: string; rows: { note: ReviewNote; index: number }[] }[] = []
	let next = startIndex
	for (const note of notes) {
		const entry = { note, index: next++ }
		const last = groups[groups.length - 1]
		if (last && last.path === note.path) last.rows.push(entry)
		else groups.push({ path: note.path, rows: [entry] })
	}
	return groups
}

export function NoteSection({
	label,
	notes,
	startIndex,
	currentPath,
	empty,
}: {
	label: string
	notes: ReviewNote[]
	startIndex: number
	currentPath: string | null
	empty: string
}): ReactElement {
	if (!notes.length)
		return (
			<div className="notes-section">
				<div className="notes-label">{label}</div>
				<div className="notes-none">{empty}</div>
			</div>
		)
	// Group by file, preserving the notes' review order (files arrive ordered).
	const groups = groupByFile(notes, startIndex)
	return (
		<div className="notes-section">
			<div className="notes-label">
				{label}
				<span className="notes-label-count">{notes.length}</span>
			</div>
			{groups.map(group => (
				<div className="notes-file" key={group.path}>
					<div className="notes-file-name" title={group.path}>
						{group.path.split('/').pop()}
					</div>
					{group.rows.map(entry => (
						<NoteRow
							key={entry.note.comments[0].id}
							note={entry.note}
							index={entry.index}
							current={entry.note.path === currentPath}
						/>
					))}
				</div>
			))}
		</div>
	)
}

export function NotesEmpty(): ReactElement {
	return (
		<div className="notes-empty">
			No comments or questions yet. Comment on a line or a file, or ask
			the agent a question.
		</div>
	)
}

export function NotesNoMatch(): ReactElement {
	const { S } = chromeCtx()
	return (
		<div className="notes-empty">
			No notes match the filter.
			<button
				className="notes-clear"
				onClick={() => {
					S.setNotesQuery?.('')
					S.setNotesLens?.('all')
				}}
			>
				Clear filter
			</button>
		</div>
	)
}
