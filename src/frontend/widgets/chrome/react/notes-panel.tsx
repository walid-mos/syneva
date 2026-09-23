import { reviewNotes } from '@entities/review/notes'
import { useStoreFields } from '@shared/lib/use-store-version'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import type { ReviewNote } from '@entities/review/notes'
import type { ReactElement } from 'react'

// The review-notes panel: every comment and question thread of the WHOLE review, one
// click from any file. Two sections - Questions first (the live conversation with the
// agent), then Comments - each grouped by file in review order, because "which file is
// this on" is the first thing a reviewer scans for. A row click jumps to the thread's
// exact spot, switching files when it has to (S.jumpToNote); the panel stays open so
// notes can be hopped one after another.

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

function NoteRow({ note }: { note: ReviewNote }): ReactElement {
	const { S } = chromeCtx()
	return (
		<button
			className={`note${note.status === 'resolved' ? ' resolved' : ''}`}
			data-status={note.status}
			onClick={() => S.jumpToNote?.(note)}
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

function NoteSection({
	label,
	notes,
	empty,
}: {
	label: string
	notes: ReviewNote[]
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
	const files: { path: string; notes: ReviewNote[] }[] = []
	for (const note of notes) {
		const last = files[files.length - 1]
		if (last && last.path === note.path) last.notes.push(note)
		else files.push({ path: note.path, notes: [note] })
	}
	return (
		<div className="notes-section">
			<div className="notes-label">
				{label}
				<span className="notes-label-count">{notes.length}</span>
			</div>
			{files.map(file => (
				<div className="notes-file" key={file.path}>
					<div className="notes-file-name" title={file.path}>
						{file.path.split('/').pop()}
					</div>
					{file.notes.map(note => (
						<NoteRow key={note.comments[0].id} note={note} />
					))}
				</div>
			))}
		</div>
	)
}

export function NotesPanel(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('state', 'notesOpen', 'fileIndex', 'preview')
	const notes = reviewNotes(S.state)
	const questions = notes.filter(n => n.kind === 'question')
	const comments = notes.filter(n => n.kind === 'comment')
	return (
		<aside className="notes">
			<header className="notes-head">
				<span className="notes-title">Review notes</span>
				<button
					className="btn icon notes-close"
					data-tip="Close (Esc)"
					aria-label="Close review notes"
					onClick={() => {
						S.notesOpen = false
					}}
				>
					<Icon id="gly-collapse-all" />
				</button>
			</header>
			<div className="notes-body">
				{!notes.length && (
					<div className="notes-empty">
						No comments or questions yet. Comment on a line or a
						file, or ask the agent a question.
					</div>
				)}
				<NoteSection
					label="Questions"
					notes={questions}
					empty="No questions asked."
				/>
				<NoteSection
					label="Comments"
					notes={comments}
					empty="No comments left."
				/>
			</div>
		</aside>
	)
}
