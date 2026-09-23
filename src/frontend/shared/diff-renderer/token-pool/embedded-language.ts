import { getFiletypeFromFileName } from '@pierre/diffs'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { WindowPositions } from './merge'

type EmbeddedLanguage = 'javascript' | 'json' | 'css'
type SideLanguages = (EmbeddedLanguage | undefined)[]
export type EmbeddedLanguages = {
	addition: SideLanguages
	deletion: SideLanguages
	names: EmbeddedLanguage[]
}

const OPEN_TAG = /<(?<tag>script|style)\b(?<attributes>[^>]*)>/i
const CLOSE_SCRIPT = /<\/script\s*>/i
const CLOSE_STYLE = /<\/style\s*>/i
const SCRIPT_TYPE = /\btype\s*=\s*(['"])(?<type>.*?)\1/i

function languageForTag(
	tag: string,
	attributes: string,
): EmbeddedLanguage | undefined {
	if (tag === 'style') return 'css'
	const type = SCRIPT_TYPE.exec(attributes)?.groups?.type?.toLowerCase()
	if (
		!type ||
		type === 'module' ||
		type === 'text/javascript' ||
		type === 'application/javascript'
	)
		return 'javascript'
	if (type === 'application/json' || type === 'application/ld+json')
		return 'json'
	return undefined
}

function openingLanguage(
	line: string,
	names: Set<EmbeddedLanguage>,
): EmbeddedLanguage | undefined {
	const open = OPEN_TAG.exec(line)
	const tag = open?.groups?.tag?.toLowerCase()
	if (!open || !tag) return undefined
	const close = tag === 'style' ? CLOSE_STYLE : CLOSE_SCRIPT
	if (close.test(line.slice(open.index + open[0].length))) return undefined
	const language = languageForTag(tag, open.groups?.attributes ?? '')
	if (language) names.add(language)
	return language
}

// A window starts a fresh grammar state. Mark only whole lines inside embedded code: the HTML
// grammar handles the tag lines, while a window entirely within the body needs its own grammar.
function scan(lines: string[], names: Set<EmbeddedLanguage>): SideLanguages {
	const languages: SideLanguages = []
	let inside: EmbeddedLanguage | undefined
	for (const line of lines) {
		const closes = inside === 'css' ? CLOSE_STYLE : CLOSE_SCRIPT
		if (inside && closes.test(line)) inside = undefined
		languages.push(inside)
		if (!inside) inside = openingLanguage(line, names)
	}
	return languages
}

export function embeddedLanguages(
	diff: FileDiffMetadata,
): EmbeddedLanguages | undefined {
	if ((diff.lang ?? getFiletypeFromFileName(diff.name)) !== 'html')
		return undefined
	const names = new Set<EmbeddedLanguage>()
	const addition = scan(diff.additionLines, names)
	const deletion = scan(diff.deletionLines, names)
	if (!names.size) return undefined
	return { addition, deletion, names: [...names] }
}

export function windowLanguage(
	embedded: EmbeddedLanguages | undefined,
	positions: WindowPositions,
): EmbeddedLanguage | undefined {
	if (!embedded) return undefined
	const language =
		embedded.addition[positions.addition[0]] ??
		embedded.deletion[positions.deletion[0]]
	if (
		language &&
		positions.addition.every(
			index => embedded.addition[index] === language,
		) &&
		positions.deletion.every(index => embedded.deletion[index] === language)
	)
		return language
	return undefined
}
