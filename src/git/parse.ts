import { gitStats } from './repo.js'

import type { DiffFile, DiffHunk } from '../types.js'

const DIFF_HEADER = /^diff --git a\/(.*?) b\/(.*)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

const OLD_PATH_PREFIX = 'a/'
const NEW_PATH_PREFIX = 'b/'
const RENAME_FROM = 'rename from '
const RENAME_TO = 'rename to '
const PATH_HEADER_PREFIX = '--- '
const NEW_PATH_HEADER_PREFIX = '+++ '
const DEV_NULL = '/dev/null'
const NO_NEWLINE_MARKER = '\\ No newline'
const CONTENT_PREFIX_LENGTH = 1
const DEFAULT_HUNK_COUNT = 1

// Line-by-line unified-diff parser. Kept as an object so the running cursor (current file,
// hunk, line numbers) lives on `this` instead of a mutable state bag threaded through helpers.
class DiffParser {
	private readonly files: DiffFile[] = []
	private file: DiffFile | undefined
	private hunk: DiffHunk | undefined
	private oldLine = 0
	private newLine = 0
	private diffPosition = 0
	// Files whose content section is binary ("Binary files … differ" / "GIT binary patch") - a
	// transient parse-time set (never a DiffFile field, so it can't leak into ReviewFile). Used
	// to drop a renamed binary: it's zero-hunk with distinct paths, so the rename-keep rule below
	// would otherwise keep it and its bytes would later be read as mangled utf8 text (fileAt).
	private readonly binaryFiles = new WeakSet<DiffFile>()
	// Files whose paths came from the `rename from`/`rename to` extended headers - those give the
	// raw, unprefixed path (reliable for paths with spaces, unlike the `diff --git`/`--- +++`
	// regexes), so once set we don't let the later `--- a/`/`+++ b/` lines clobber them.
	private readonly renamedFiles = new WeakSet<DiffFile>()

	parse(raw: string): DiffFile[] {
		for (const rawLine of raw.split(/\r?\n/)) this.consumeLine(rawLine)
		return this.files.filter(file => this.isReviewable(file))
	}

	private consumeLine(rawLine: string): void {
		if (rawLine.startsWith('diff --git ')) {
			this.startFile(rawLine)
			return
		}
		const { file } = this
		if (!file) return
		if (this.applyRenameHeader(rawLine)) return
		if (this.isBinaryMarker(rawLine)) {
			this.binaryFiles.add(file)
			return
		}
		if (this.applyPathHeader(rawLine)) return
		if (this.startHunk(rawLine)) return
		this.appendContentLine(rawLine)
	}

	private startFile(rawLine: string): void {
		const file: DiffFile = { hunks: [] }
		const [, oldPath, newPath] = rawLine.match(DIFF_HEADER) ?? []
		if (oldPath) file.oldPath = oldPath
		if (newPath) file.newPath = newPath
		this.file = file
		this.hunk = undefined
		this.diffPosition = 0
		this.files.push(file)
	}

	private applyRenameHeader(rawLine: string): boolean {
		const { file } = this
		if (!file) return false
		if (rawLine.startsWith(RENAME_FROM)) {
			file.oldPath = rawLine.slice(RENAME_FROM.length)
			this.renamedFiles.add(file)
			return true
		}
		if (rawLine.startsWith(RENAME_TO)) {
			file.newPath = rawLine.slice(RENAME_TO.length)
			this.renamedFiles.add(file)
			return true
		}
		return false
	}

	private isBinaryMarker(rawLine: string): boolean {
		return (
			rawLine.startsWith('Binary files ') ||
			rawLine.startsWith('GIT binary patch')
		)
	}

	private applyPathHeader(rawLine: string): boolean {
		const { file } = this
		if (!file) return false
		if (rawLine.startsWith(PATH_HEADER_PREFIX)) {
			if (!this.renamedFiles.has(file))
				file.oldPath = resolvePath(
					rawLine.slice(PATH_HEADER_PREFIX.length),
					OLD_PATH_PREFIX,
				)
			return true
		}
		if (rawLine.startsWith(NEW_PATH_HEADER_PREFIX)) {
			if (!this.renamedFiles.has(file))
				file.newPath = resolvePath(
					rawLine.slice(NEW_PATH_HEADER_PREFIX.length),
					NEW_PATH_PREFIX,
				)
			return true
		}
		return false
	}

	private startHunk(rawLine: string): boolean {
		const { file } = this
		if (!file) return false
		const match = rawLine.match(HUNK_HEADER)
		if (!match) return false
		// The count groups are optional in a hunk header, so a match can leave them absent even
		// though destructuring a match array types every slot as `string`.
		const captures: (string | undefined)[] = match
		const [, rawOldStart, rawOldCount, rawNewStart, rawNewCount] = captures
		const hunk: DiffHunk = {
			header: rawLine,
			oldStart: Number(rawOldStart),
			oldCount: Number(rawOldCount ?? DEFAULT_HUNK_COUNT),
			newStart: Number(rawNewStart),
			newCount: Number(rawNewCount ?? DEFAULT_HUNK_COUNT),
			lines: [],
		}
		file.hunks.push(hunk)
		this.hunk = hunk
		this.oldLine = hunk.oldStart
		this.newLine = hunk.newStart
		this.diffPosition = 0
		return true
	}

	private appendContentLine(rawLine: string): void {
		const { hunk } = this
		if (!hunk || rawLine.startsWith(NO_NEWLINE_MARKER)) return
		const [prefix] = rawLine
		if (prefix !== ' ' && prefix !== '+' && prefix !== '-') return
		this.diffPosition++
		const text = rawLine.slice(CONTENT_PREFIX_LENGTH)
		const base = {
			text,
			diffPosition: this.diffPosition,
			hunkHeader: hunk.header,
		}
		if (prefix === ' ') {
			hunk.lines.push({
				...base,
				kind: 'context',
				oldLine: this.oldLine,
				newLine: this.newLine,
			})
			this.oldLine++
			this.newLine++
			return
		}
		if (prefix === '+') {
			hunk.lines.push({ ...base, kind: 'add', newLine: this.newLine })
			this.newLine++
			return
		}
		hunk.lines.push({ ...base, kind: 'delete', oldLine: this.oldLine })
		this.oldLine++
	}

	// Keep every file that has real hunks, plus a zero-hunk PURE rename (git -M with 100%
	// similarity emits no content) - distinct old/new paths and not binary. A renamed binary is
	// also zero-hunk with distinct paths, but its "Binary files … differ" line marks it (excluded
	// so its bytes aren't read as text); same-path zero-hunk sections (mode-only changes, same-path
	// binary diffs) have no rename to surface and stay dropped.
	private isReviewable(file: DiffFile): boolean {
		if (file.hunks.length) return true
		return (
			!!file.oldPath &&
			!!file.newPath &&
			file.oldPath !== file.newPath &&
			!this.binaryFiles.has(file)
		)
	}
}

function resolvePath(rawPath: string, prefix: string): string | undefined {
	const trimmed = rawPath.trim()
	if (trimmed === DEV_NULL) return undefined
	return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

export function parseUnifiedDiff(raw: string): DiffFile[] {
	gitStats.parses++
	return new DiffParser().parse(raw)
}
