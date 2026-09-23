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

const EMBEDDED_TAG =
	/<(?<closing>\/)?(?<tag>script|style)\b(?<attributes>[^>]*)>/gi
const SCRIPT_TYPE =
	/\btype\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s>]+))/i

function languageForTag(
	tag: string,
	attributes: string,
): EmbeddedLanguage | undefined {
	if (tag === 'style') return 'css'
	const match = SCRIPT_TYPE.exec(attributes)?.groups
	const type = (match?.double ?? match?.single ?? match?.bare)?.toLowerCase()
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

type OpenTag = { tag: string; language: EmbeddedLanguage | undefined }

function advanceTag(
	inside: OpenTag | undefined,
	match: RegExpMatchArray,
	names: Set<EmbeddedLanguage>,
): OpenTag | undefined {
	const { closing, tag, attributes } = match.groups ?? {}
	if (!tag) return inside
	const normalizedTag = tag.toLowerCase()
	if (closing) {
		if (inside?.tag !== normalizedTag) return inside
		return undefined
	}
	if (inside) return inside
	const language = languageForTag(normalizedTag, attributes ?? '')
	if (language) names.add(language)
	return { tag: normalizedTag, language }
}

// A window starts a fresh grammar state. Mark only whole lines inside embedded code: the HTML
// grammar handles tag lines, while a window entirely within the body needs its own grammar.
function scan(lines: string[], names: Set<EmbeddedLanguage>): SideLanguages {
	const languages: SideLanguages = []
	let inside: OpenTag | undefined
	for (const line of lines) {
		let rowLanguage = inside?.language
		for (const match of line.matchAll(EMBEDDED_TAG)) {
			rowLanguage = undefined
			inside = advanceTag(inside, match, names)
		}
		languages.push(rowLanguage)
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
