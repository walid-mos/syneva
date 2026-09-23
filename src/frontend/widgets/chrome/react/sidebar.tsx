import { useStoreFields } from '@shared/lib/use-store-version'
import { varStyle } from '@shared/lib/var-style'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import { WalkNode } from './walkthrough-rows'

import type { TreeRow } from '@entities/review/file/tree-rows'
import type { CSSProperties } from 'react'
import type { ReactElement } from 'react'

// The sidebar: Tree / Walkthrough tabs (guide-attached desks only), the file tree,
// the walkthrough list, and the settings button. Rows render from the store methods
// (treeRows()/walkthroughRows()); walkthrough rows carry their own derived classes
// (walkRows() takes the active path). One click handler covers every row kind -
// rowClick() dispatches dir toggles, fold groups, previews and file selection.

function activePath(S: ReturnType<typeof chromeCtx>['S']): string | null {
	// No file is "active" on the Overview; a previewed file wins over the indexed review file.
	if (S.overviewOpen) return null
	return S.preview?.path ?? S.state?.files.at(S.fileIndex)?.path ?? null
}

function ChangedIcon({ changeType }: { changeType: string }): ReactElement {
	return <Icon id="gly-file" className={`file ${changeType}`} />
}

function MovedFrom({ from }: { from: string }): ReactElement {
	return (
		<span
			className="moved-from"
			title={`moved from ${from}`}
		>{`← ${from}`}</span>
	)
}

function StateBadge({ state }: { state: string }): ReactElement {
	const badges: Record<string, { id: string; title: string }> = {
		pending: { id: 'gly-dot', title: 'Pending review' },
		approved: { id: 'gly-check', title: 'Approved' },
		'changes-requested': { id: 'gly-flag', title: 'Changes requested' },
	}
	const badge = badges[state]
	if (!badge) return <></>
	return (
		<Icon id={badge.id} className={`badge ${state}`} title={badge.title} />
	)
}

function TestCaret({
	testKey,
	testCaret,
}: {
	testKey: string
	testCaret: string
}): ReactElement {
	const { S } = chromeCtx()
	const open = testCaret === '▾'
	return (
		<span
			className="testcaret"
			onClick={event => {
				event.stopPropagation()
				S.toggleTestDir?.(testKey)
			}}
		>
			<Icon id="gly-chevron" className={open ? 'chev open' : 'chev'} />
		</span>
	)
}

function DirRowBody({ row }: { row: Extract<TreeRow, { kind: 'dir' }> }): ReactElement {
	return (
		<>
			<Icon
				id="gly-chevron"
				className={row.open ? 'chev open' : 'chev'}
			/>
			<Icon id="gly-folder" className="folder" />
			<span className="nm">{row.name}</span>
		</>
	)
}

function FileRowBody({ row }: { row: Extract<TreeRow, { kind: 'file' | 'test' }> }): ReactElement {
	return (
		<>
			<span className="chev-spacer" />
			{row.changeType && <ChangedIcon changeType={row.changeType} />}
			<span className="nm">{row.name}</span>
			{row.movedFrom && <MovedFrom from={row.movedFrom} />}
			{row.testToggle && (
				<TestCaret testKey={row.testKey} testCaret={row.testCaret} />
			)}
			{row.state && (
				<span className="status-pack">
					<StateBadge state={row.state} />
				</span>
			)}
		</>
	)
}

function FoldGroupBody({ row }: { row: Extract<TreeRow, { kind: 'foldgrp' }> }): ReactElement {
	return (
		<>
			<Icon
				id="gly-chevron"
				className={row.open ? 'chev open' : 'chev'}
			/>
			<span className="nm foldgrp-name">
				{row.group === 'reviewed' ? 'Reviewed' : 'Renamed'}
			</span>
			<span className="foldgrp-count">
				{row.count + (row.count === 1 ? ' file' : ' files')}
			</span>
		</>
	)
}

function rowVars(row: TreeRow): CSSProperties | undefined {
	if (row.kind === 'foldgrp') return undefined
	return varStyle(row.style)
}

function treeNodeClass(row: TreeRow, isActive: boolean): string {
	const cls: string[] = ['node', row.kind === 'foldgrp' ? 'foldgrp' : row.cls]
	if (isActive) cls.push('active')
	return cls.filter(Boolean).join(' ')
}

function TreeRowNode({
	row,
	isActive,
}: {
	row: TreeRow
	isActive: boolean
}): ReactElement {
	const { S } = chromeCtx()
	return (
		<div
			role="button"
			tabIndex={0}
			className={treeNodeClass(row, isActive)}
			data-key={row.key}
			style={rowVars(row)}
			onClick={() => S.rowClick?.(row)}
		>
			{row.kind === 'dir' && <DirRowBody row={row} />}
			{(row.kind === 'file' || row.kind === 'test') && (
				<FileRowBody row={row} />
			)}
			{row.kind === 'foldgrp' && <FoldGroupBody row={row} />}
		</div>
	)
}

// The w hint sits on the INACTIVE tab - the one pressing w switches to.
function TreeTabs(): ReactElement {
	const { S } = chromeCtx()
	return (
		<div className="tree-tabs">
			<button
				className={S.sidebarTab === 'tree' ? 'active' : ''}
				onClick={() => {
					S.sidebarTab = 'tree'
				}}
			>
				Tree
				{S.sidebarTab !== 'tree' && <kbd>w</kbd>}
			</button>
			<button
				className={S.sidebarTab === 'walkthrough' ? 'active' : ''}
				onClick={() => {
					S.sidebarTab = 'walkthrough'
				}}
			>
				Walkthrough
				{S.sidebarTab === 'tree' && <kbd>w</kbd>}
			</button>
		</div>
	)
}

function TreePane({ active }: { active: string | null }): ReactElement {
	const { S } = chromeCtx()
	const rows = S.treeRows?.() ?? []
	return (
		<>
			<div className="label tree-title">
				<span>Files</span>
				<button
					className="tree-toggle"
					onClick={() => S.toggleAllDirs?.()}
					title={S.treeAnyOpen?.() ? 'Collapse all' : 'Expand all'}
				>
					{S.treeAnyOpen?.() ? (
						<Icon id="gly-collapse-all" />
					) : (
						<Icon id="gly-expand-all" />
					)}
				</button>
			</div>
			<div id="files">
				{rows.map(row => (
					<TreeRowNode
						key={row.key}
						row={row}
						isActive={Boolean(
							active &&
							(row.key === `file:${active}` ||
								row.key === `test:${active}`),
						)}
					/>
				))}
			</div>
		</>
	)
}

// The sidebar body: tabs (guide only), tree, walkthrough. `sidebarTab` switches the
// panes; the tree pane also hosts the Files header with expand/collapse-all.
export function Sidebar(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields(
		'state',
		'fileIndex',
		'preview',
		'overviewOpen',
		'sidebarTab',
		'treeDrawerOpen',
		'foldExpanded',
		'expandedDirs',
		'collapsedDirs',
		'loadedOversized',
		'settings',
	)
	const guided = S.hasGuide?.() ?? false
	const showTree = !guided || S.sidebarTab === 'tree'
	return (
		<aside className={`tree${S.treeDrawerOpen ? ' drawer-open' : ''}`}>
			{guided && <TreeTabs />}
			{showTree && <TreePane active={activePath(S)} />}
			{guided && S.sidebarTab === 'walkthrough' && (
				<div id="walk">
					{(S.walkthroughRows?.() ?? []).map(row => (
						<WalkNode key={row.key} row={row} />
					))}
				</div>
			)}
			<button
				className="tree-settings"
				onClick={() => S.openSettings?.()}
			>
				<Icon id="gly-settings" />
				<span>Settings</span>
				<kbd>⇧,</kbd>
			</button>
		</aside>
	)
}
