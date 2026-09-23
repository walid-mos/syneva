import { useStoreFields } from '@shared/lib/use-store-version'

import {
	APPEARANCE_SELECTS,
	BEHAVIOR_SELECTS,
	CODE_SIZE,
	DIFF_SELECTS,
	EDITOR_COMMAND,
	TREE_SELECTS,
} from './settings-descriptors'

import type { ReactElement } from 'react'
import type {
	NumberSpec,
	Option,
	OptionGroup,
	SelectSpec,
	TextSpec,
} from './settings-descriptors'

// A table-driven settings pane: each control is a descriptor (label + options +
// read/write through the store), so the grid renders from data instead of four
// near-identical JSX blocks. Descriptors read the live store through chromeCtx()
// at call time - the pane re-renders on every store bump.

function isGrouped(
	options: Option[] | OptionGroup[],
): options is OptionGroup[] {
	return 'group' in options[0]
}

function SettingSelect({ spec }: { spec: SelectSpec }): ReactElement {
	return (
		<label>
			{spec.label}
			<select
				value={String(spec.get())}
				onChange={event => spec.set(event.target.value)}
			>
				{isGrouped(spec.options)
					? spec.options.map(group => (
							<optgroup key={group.group} label={group.group}>
								{group.options.map(option => (
									<option
										key={option.value}
										value={option.value}
									>
										{option.name}
									</option>
								))}
							</optgroup>
						))
					: spec.options.map(option => (
							<option key={option.value} value={option.value}>
								{option.name}
							</option>
						))}
			</select>
		</label>
	)
}

function SettingNumber({ spec }: { spec: NumberSpec }): ReactElement {
	return (
		<label>
			{spec.label}
			<input
				type="number"
				min={spec.min}
				max={spec.max}
				step={spec.step}
				value={spec.get()}
				onChange={event => spec.set(Number(event.target.value))}
			/>
		</label>
	)
}

function SettingText({ spec }: { spec: TextSpec }): ReactElement {
	return (
		<label>
			{spec.label}
			<input
				type="text"
				placeholder={spec.placeholder}
				value={spec.get()}
				onChange={event => spec.set(event.target.value)}
			/>
		</label>
	)
}

function SettingSection({
	title,
	selects,
	number,
	text,
}: {
	title: string
	selects: SelectSpec[]
	number?: NumberSpec
	text?: TextSpec
}): ReactElement {
	useStoreFields('settings', 'diffStyle')
	return (
		<>
			<div className="set-section">{title}</div>
			<div className="set-grid">
				{selects.map(spec => (
					<SettingSelect key={spec.label} spec={spec} />
				))}
				{number && <SettingNumber spec={number} />}
				{text && <SettingText spec={text} />}
			</div>
		</>
	)
}

export function SettingsPane(): ReactElement {
	return (
		<div className="set-pane">
			<SettingSection title="Diff" selects={DIFF_SELECTS} />
			<SettingSection
				title="Appearance"
				selects={APPEARANCE_SELECTS}
				number={CODE_SIZE}
			/>
			<SettingSection title="File tree" selects={TREE_SELECTS} />
			<SettingSection
				title="Behavior"
				selects={BEHAVIOR_SELECTS}
				text={EDITOR_COMMAND}
			/>
		</div>
	)
}
