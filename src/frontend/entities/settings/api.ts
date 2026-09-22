import { API_PATHS } from '@contracts/routes'
import { api } from '@shared/api/client'
import {
	assertObject,
	DecodeError,
	optBoolean,
	optEnum,
	optNumber,
	optString,
	requiredBoolean,
} from '@shared/api/decode'

import type { DiffStyle } from '@shared/diff-renderer/types'
import type { Settings } from './model'

// The settings entity's API boundary: display preferences persist to the global
// ~/.syneva/settings.json (NOT localStorage - origins change with the random port).

// One Settings key's decode+assign step: the generic write keeps the key and the
// decoded value correlated, so the wire→model mapping needs no assertion.
type SettingsPut = <K extends keyof Settings>(
	key: K,
	decoded: Settings[K] | undefined,
) => void

function decodeEnumSettings(
	wire: Record<string, unknown>,
	endpoint: string,
	put: SettingsPut,
): void {
	const enums: readonly (readonly [keyof Settings, readonly string[]])[] = [
		['lineDiffType', ['word-alt', 'word', 'char', 'none']],
		['diffIndicators', ['bars', 'classic', 'none']],
		[
			'hunkSeparators',
			['line-info', 'simple', 'metadata', 'line-info-basic'],
		],
		['overflow', ['scroll', 'wrap']],
		['lineHighlight', ['full', 'subtle', 'off']],
		['appearance', ['dark', 'light']],
		['unchangedLines', ['collapse', 'expand']],
		['progressBy', ['lines', 'files']],
		['sidebarDefault', ['tree', 'walkthrough']],
		['markdownView', ['auto', 'rendered', 'source']],
	]
	for (const [key, allowed] of enums)
		put(key, optEnum(wire, key, endpoint, allowed))
}

function decodeScalarSettings(
	wire: Record<string, unknown>,
	endpoint: string,
	put: SettingsPut,
): void {
	const bools: (keyof Settings)[] = [
		'showUnchanged',
		'hideReviewed',
		'stageOnAccept',
	]
	for (const key of bools) put(key, optBoolean(wire, key, endpoint))
	const numbers: (keyof Settings)[] = ['fontSize', 'tabSize']
	for (const key of numbers) put(key, optNumber(wire, key, endpoint))
	const strings: (keyof Settings)[] = [
		'theme',
		'font',
		'uiFont',
		'editorCommand',
	]
	for (const key of strings) put(key, optString(wire, key, endpoint))
}

// Map only the known Settings keys: each is validated (enum membership, boolean,
// string, finite number); absent or unknown settings are ignored so the desk's
// defaults and forward compatibility stay intact.
export function decodeSettings(
	raw: unknown,
	endpoint: string,
): Partial<Settings> {
	const wire = assertObject(raw, endpoint, 'settings')
	const out: Partial<Settings> = {}
	// A nullish decoded value is an absent/invalid setting: keep what's already there
	// (a no-op write) so legitimate false/0/'' settings still land.
	const put: SettingsPut = <K extends keyof Settings>(
		key: K,
		decoded: Settings[K] | undefined,
	): void => {
		out[key] = decoded ?? out[key]
	}
	decodeEnumSettings(wire, endpoint, put)
	decodeScalarSettings(wire, endpoint, put)
	return out
}

export type DisplayPrefs = {
	settings?: Partial<Settings>
	diffStyle?: DiffStyle
}

// An unreachable desk falls back to the defaults at the call site.
export const fetchPrefs = async (): Promise<DisplayPrefs> => {
	const raw = await api(API_PATHS.settings)
	const o = assertObject(raw, API_PATHS.settings)
	return {
		settings: o.settings
			? decodeSettings(o.settings, API_PATHS.settings)
			: undefined,
		diffStyle: optEnum(o, 'diffStyle', API_PATHS.settings, [
			'split',
			'unified',
		] as const),
	}
}

// Best-effort: an unreachable desk must not break the settings UI.
export const persistSettings = async (prefs: {
	settings: Settings
	diffStyle: DiffStyle
}): Promise<void> => {
	try {
		const raw = await api(API_PATHS.settings, {
			method: 'POST',
			body: JSON.stringify(prefs),
		})
		// Decode the { ok: true } acknowledgement even on this best-effort write: a 2xx
		// body that isn't the promised shape fails here, never as raw wire.
		if (
			!requiredBoolean(
				assertObject(raw, API_PATHS.settings),
				'ok',
				API_PATHS.settings,
			)
		)
			throw new DecodeError(
				'acknowledgement ok is false',
				API_PATHS.settings,
			)
	} catch {
		// Preferences are best-effort: an unreachable desk must not break the settings UI.
	}
}
