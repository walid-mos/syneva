import { useEffect, useRef } from 'react'

import {
	notesPanelView,
	reviewNotes,
	unresolvedNoteCount,
} from '@entities/review/notes'
import { useStoreFields } from '@shared/lib/use-store-version'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import { NoteSection, NotesEmpty, NotesNoMatch } from './notes-panel-rows'

import type { NotesLens, ReviewNote } from '@entities/review/notes'
import type { KeyboardEvent, ReactElement, RefObject } from 'react'

// The review-notes panel: every comment and question thread of the WHOLE review, one
// click from any file. Two sections - Questions first (the live conversation with the
// agent), then Comments - each grouped by file in review order (the row layer lives in
// notes-panel-rows). A row click jumps to the thread's exact spot, switching files when
// it has to (S.jumpToNote); the panel stays open so notes can be hopped one after
// another.
//
// The pane is also drivable: a filter box (query against path/body/line), a status lens
// (All / Open / Resolved), and a keyboard cursor over the flat visible rows - ↑/↓ move,
// ↵ jumps, '/' focuses the filter (HOTKEYS_NOTES; Esc clears the query before it closes
// the panel). What is visible comes from notesPanelView alone, so the cursor, the
// facade's moves and this render can never disagree. All of it is per-session state on
// the store (notesQuery/notesLens/notesCursor), never persisted.

const LENSES: { value: NotesLens; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'open', label: 'Open' },
	{ value: 'resolved', label: 'Resolved' },
]

type StoreView = ReturnType<typeof chromeCtx>['S']

// The file the desk is on right now (preview wins over the indexed review file, like
// the tree's active row; none on the Overview) - the panel marks its rows with a rail.
function activePath(S: StoreView): string | null {
	if (S.overviewOpen) return null
	return S.preview?.path ?? S.state?.files.at(S.fileIndex)?.path ?? null
}

// Arrow/Enter handling while typing in the filter: the global map's typing gate keeps
// those keys away from the panel's cursor bindings, so the field drives them directly.
function searchKeys(
	S: StoreView,
): (event: KeyboardEvent<HTMLInputElement>) => void {
	return event => {
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			S.notesCursorMove?.(1)
		} else if (event.key === 'ArrowUp') {
			event.preventDefault()
			S.notesCursorMove?.(-1)
		} else if (event.key === 'Enter') {
			event.preventDefault()
			S.notesJumpCursor?.()
		}
	}
}

function NotesHead({ unresolved }: { unresolved: number }): ReactElement {
	const { S } = chromeCtx()
	return (
		<header className="notes-head">
			<span className="notes-title">Review notes</span>
			{unresolved > 0 && (
				<span className="notes-open-pill">{unresolved} open</span>
			)}
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
	)
}

function NotesTools({
	inputRef,
}: {
	inputRef: RefObject<HTMLInputElement | null>
}): ReactElement {
	const { S } = chromeCtx()
	return (
		<div className="notes-tools">
			<div className="notes-search">
				<input
					ref={inputRef}
					value={S.notesQuery}
					placeholder="Filter notes"
					spellCheck={false}
					aria-label="Filter notes"
					onChange={event => S.setNotesQuery?.(event.target.value)}
					onKeyDown={searchKeys(S)}
				/>
				<kbd>/</kbd>
			</div>
			<div className="notes-lens" role="group" aria-label="Note status">
				{LENSES.map(lens => (
					<button
						key={lens.value}
						className={S.notesLens === lens.value ? 'active' : ''}
						aria-pressed={S.notesLens === lens.value}
						onClick={() => S.setNotesLens?.(lens.value)}
					>
						{lens.label}
					</button>
				))}
			</div>
		</div>
	)
}

function NotesBody({
	questions,
	comments,
	flat,
	currentPath,
	filtered,
}: {
	questions: ReviewNote[]
	comments: ReviewNote[]
	flat: ReviewNote[]
	currentPath: string | null
	filtered: boolean
}): ReactElement {
	if (!flat.length) return filtered ? <NotesNoMatch /> : <NotesEmpty />
	const sections = [
		{
			label: 'Questions',
			notes: questions,
			startIndex: 0,
			empty: 'No questions asked.',
		},
		{
			label: 'Comments',
			notes: comments,
			startIndex: questions.length,
			empty: 'No comments left.',
		},
	]
	return (
		<>
			{sections.map(section => (
				<NoteSection
					key={section.label}
					{...section}
					currentPath={currentPath}
				/>
			))}
		</>
	)
}

export function NotesPanel(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields(
		'state',
		'fileIndex',
		'preview',
		'overviewOpen',
		'notesQuery',
		'notesLens',
		'notesCursor',
		'notesSearchTick',
	)
	const notes = reviewNotes(S.state)
	const { questions, comments, flat } = notesPanelView(S.state, {
		query: S.notesQuery,
		lens: S.notesLens,
	})
	const inputRef = useRef<HTMLInputElement | null>(null)
	const searchTick = S.notesSearchTick
	const cursor = S.notesCursor
	const filtered = Boolean(S.notesQuery.trim()) || S.notesLens !== 'all'

	// The '/' pulse: focus the filter box. Tick 0 is the mount - only bumps focus.
	useEffect(() => {
		if (searchTick > 0) inputRef.current?.focus()
	}, [searchTick])

	// Keyboard cursor: keep the row it lands on in view (block:'nearest' scrolls the
	// least; a cursor already visible is a no-op).
	useEffect(() => {
		if (cursor > 0)
			document
				.querySelector('.note.cursor')
				?.scrollIntoView({ block: 'nearest' })
	}, [cursor])

	return (
		<aside className="notes">
			<NotesHead unresolved={unresolvedNoteCount(notes)} />
			<NotesTools inputRef={inputRef} />
			<div className="notes-body">
				<NotesBody
					questions={questions}
					comments={comments}
					flat={flat}
					currentPath={activePath(S)}
					filtered={filtered}
				/>
			</div>
		</aside>
	)
}
