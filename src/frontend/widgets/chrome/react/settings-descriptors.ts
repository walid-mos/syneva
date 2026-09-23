// The settings descriptors: one entry per control in the preferences grid.
// Each reads/writes the live store through chromeCtx() at call time, so the
// pane re-renders from the store-version subscription like every other chrome view.

import { chromeCtx } from '../context'

import type { Settings } from '@entities/settings/model'

// The select descriptors carry string options; applySetting is the one write
// boundary that narrows a string back to its Settings field's union.
function applySetting<K extends keyof Settings>(
	key: K,
	next: string | number | boolean,
): void {
	chromeCtx().S.settings[key] = next as Settings[K]
	chromeCtx().S.applySettings?.()
}

import { opts, CODE_THEMES } from './code-themes'

import type { Option, OptionGroup } from './code-themes'

type SelectSpec = {
	label: string
	options: Option[] | OptionGroup[]
	get: () => string | number | boolean
	set: (value: string) => void
}

type NumberSpec = {
	label: string
	min: number
	max: number
	step: number
	get: () => number
	set: (value: number) => void
}

type TextSpec = {
	label: string
	placeholder: string
	get: () => string
	set: (value: string) => void
}

export const DIFF_SELECTS: SelectSpec[] = [
	{
		label: 'Intra-line',
		options: opts(
			['word-alt', 'Word'],
			['char', 'Character'],
			['none', 'None'],
		),
		get: () => chromeCtx().S.settings.lineDiffType,
		set: next => {
			applySetting('lineDiffType', next)
		},
	},
	{
		label: 'Change indicators',
		options: opts(
			['bars', 'Bars'],
			['classic', 'Classic'],
			['none', 'None'],
		),
		get: () => chromeCtx().S.settings.diffIndicators,
		set: next => {
			applySetting('diffIndicators', next)
		},
	},
	{
		label: 'Hunk separators',
		options: opts(
			['line-info', 'Line info'],
			['simple', 'Simple'],
			['metadata', 'Metadata'],
		),
		get: () => chromeCtx().S.settings.hunkSeparators,
		set: next => {
			applySetting('hunkSeparators', next)
		},
	},
	{
		label: 'Line wrapping',
		options: opts(['scroll', 'Scroll'], ['wrap', 'Wrap']),
		get: () => chromeCtx().S.settings.overflow,
		set: next => {
			applySetting('overflow', next)
		},
	},
	{
		label: 'Line highlight',
		options: opts(
			['full', 'Full'],
			['subtle', 'Subtle'],
			['off', 'Off (word only)'],
		),
		get: () => chromeCtx().S.settings.lineHighlight,
		set: next => {
			applySetting('lineHighlight', next)
		},
	},
	{
		label: 'Unchanged lines',
		options: opts(['collapse', 'Collapse'], ['expand', 'Expand all']),
		get: () => chromeCtx().S.settings.unchangedLines,
		set: next => {
			applySetting('unchangedLines', next)
		},
	},
]

export const APPEARANCE_SELECTS: SelectSpec[] = [
	{
		label: 'Theme',
		options: opts(['dark', 'Dark'], ['light', 'Light']),
		get: () => chromeCtx().S.settings.appearance,
		set: next => {
			applySetting('appearance', next)
		},
	},
	{
		label: 'Code theme',
		options: CODE_THEMES,
		get: () => chromeCtx().S.settings.theme,
		set: next => {
			applySetting('theme', next)
		},
	},
	{
		label: 'Code font',
		options: opts(
			['jetbrains-mono', 'JetBrains Mono'],
			['geist-mono', 'Geist Mono'],
			['fira-code', 'Fira Code'],
			['ibm-plex-mono', 'IBM Plex Mono'],
			['source-code-pro', 'Source Code Pro'],
			['roboto-mono', 'Roboto Mono'],
		),
		get: () => chromeCtx().S.settings.font,
		set: next => {
			applySetting('font', next)
		},
	},
	{
		label: 'UI font',
		options: opts(
			['inter', 'Inter'],
			['geist', 'Geist'],
			['ibm-plex-sans', 'IBM Plex Sans'],
			['system', 'System'],
		),
		get: () => chromeCtx().S.settings.uiFont,
		set: next => {
			applySetting('uiFont', next)
		},
	},
	{
		label: 'Tab size',
		options: opts(['2', '2'], ['4', '4'], ['8', '8']),
		get: () => chromeCtx().S.settings.tabSize,
		set: next => {
			applySetting('tabSize', Number(next))
		},
	},
]

export const TREE_SELECTS: SelectSpec[] = [
	{
		label: 'Unchanged files',
		options: opts(['show', 'Show'], ['hide', 'Hide']),
		get: () => (chromeCtx().S.settings.showUnchanged ? 'show' : 'hide'),
		set: next => {
			applySetting('showUnchanged', next === 'show')
		},
	},
	{
		label: 'Guided sidebar opens',
		options: opts(['tree', 'Tree'], ['walkthrough', 'Walkthrough']),
		get: () => chromeCtx().S.settings.sidebarDefault,
		set: next => {
			applySetting('sidebarDefault', next)
		},
	},
]

export const BEHAVIOR_SELECTS: SelectSpec[] = [
	{
		label: 'Track progress by',
		options: opts(['lines', 'Diff lines'], ['files', 'Files']),
		get: () => chromeCtx().S.settings.progressBy,
		set: next => {
			applySetting('progressBy', next)
		},
	},
	{
		label: 'Markdown files',
		options: opts(
			['auto', 'Auto'],
			['rendered', 'Rendered'],
			['source', 'Source'],
		),
		get: () => chromeCtx().S.settings.markdownView,
		set: next => {
			applySetting('markdownView', next)
		},
	},
	{
		label: 'Approve',
		options: opts(['stage', 'Stages file'], ['verdict', 'Verdict only']),
		get: () => (chromeCtx().S.settings.stageOnAccept ? 'stage' : 'verdict'),
		set: next => {
			applySetting('stageOnAccept', next === 'stage')
		},
	},
]

export const EDITOR_COMMAND: TextSpec = {
	label: 'Editor command',
	placeholder: 'code -g {file}:{line}',
	get: () => chromeCtx().S.settings.editorCommand,
	set: next => {
		applySetting('editorCommand', next)
	},
}

// The code font size is a free number input (11-16, half steps) - the one control
// the select table can't express.
export const CODE_SIZE: NumberSpec = {
	label: 'Code size',
	min: 11,
	max: 16,
	step: 0.5,
	get: () => chromeCtx().S.settings.fontSize,
	set: next => {
		applySetting('fontSize', next)
	},
}
