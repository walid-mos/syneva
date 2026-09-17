import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getBranch, getGitRoot } from '../git/repo.js'
import { validateGuide } from '../guide.js'
import { warn } from '../output.js'
import { findLiveDesks } from '../state/desk.js'
import { sanitizeSession } from '../state/identity.js'

import type { Guide, ReviewMode } from '../types.js'

// A flag that was never passed has no key at all, so every read is `| undefined`: callers
// default it instead of trusting the index signature's non-null type.
export type CliArgs = Record<string, string | boolean | undefined>

const FLAG_PREFIX = '--'

export function parseArgs(argv: string[]): CliArgs {
	const parsed: CliArgs = { diff: 'working', open: true }
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (!arg) continue
		if (arg === '--no-open') {
			parsed.open = false
			continue
		}
		if (!arg.startsWith(FLAG_PREFIX)) continue
		const key = arg.slice(FLAG_PREFIX.length)
		const next = argv[index + 1]
		if (!next || next.startsWith(FLAG_PREFIX)) {
			parsed[key] = true
			continue
		}
		parsed[key] = next
		index++
	}
	return parsed
}

export function resolveRepo(args: CliArgs): string {
	return path.resolve(String(args.repo ?? process.cwd()))
}

// The repo root, falling back to the requested path when git can't resolve it (a
// non-repo directory still gets a desk-less error rather than a crash).
export async function resolveRoot(args: CliArgs): Promise<string> {
	const requested = resolveRepo(args)
	return getGitRoot(requested).catch(() => requested)
}

// Default session per mode: <branch> / file-<path> / pr-<ref>, overridable.
export function deskSession(
	mode: ReviewMode,
	target: string | undefined,
	branch: string,
	override?: string,
): string {
	if (override) return sanitizeSession(override)
	if (mode === 'file') return sanitizeSession(`file-${target ?? 'file'}`)
	if (mode === 'pr')
		return sanitizeSession(`pr-${prHeadLabel(target, branch)}`)
	return sanitizeSession(branch || 'review')
}

// A PR desk is named after its head: the resolved target when one was given, else the
// checked-out branch, else a bare "pr" so the session name is never empty.
function prHeadLabel(target: string | undefined, branch: string): string {
	if (target) return target
	if (branch) return branch
	return 'pr'
}

// For await/comment/reload: honor --session, else auto-find the lone live desk
// (so the agent needn't know the mode prefix), else fall back to the branch.
export async function resolveActionSession(
	root: string,
	args: CliArgs,
): Promise<string> {
	if (typeof args.session === 'string') return sanitizeSession(args.session)
	const liveDesks = await findLiveDesks(root)
	if (liveDesks.length > 1) {
		warn(
			`Multiple live desks for this repo (${liveDesks.map(desk => desk.session).join(', ')}); pass --session <id>.`,
		)
		process.exit(1)
	}
	const onlyLiveDesk = liveDesks.at(0)
	if (onlyLiveDesk) return onlyLiveDesk.session
	return sanitizeSession((await getBranch(root)) || 'review')
}

// Read + validate a guide JSON file for the `--guide` start flag. Returns the validated
// guide, undefined when the flag is absent, or null on any error (after printing why) so
// the caller can abort.
export function loadGuideArg(
	guideFlag: string | boolean | undefined,
): Guide | undefined | null {
	if (!guideFlag) return undefined
	if (typeof guideFlag !== 'string') {
		warn(
			'--guide requires a path to a guide JSON file, e.g. --guide guide.json',
		)
		return null
	}
	const SCHEMA = 'Run `syneva spec` for the full guide schema.'
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(guideFlag, 'utf8'))
	} catch (error) {
		warn(
			`Could not read guide file "${guideFlag}" as JSON: ${error instanceof Error ? error.message : String(error)}\n${SCHEMA}`,
		)
		return null
	}
	const validation = validateGuide(parsed)
	if (!validation.ok) {
		warn(`Invalid guide: ${validation.reason}.\n${SCHEMA}`)
		return null
	}
	return validation.guide
}

// A `syneva pr <ref>` target is a PR number (`123`) or a GitHub PR URL when it matches these;
// anything else is treated as a plain branch name (the original behavior).
export function isPrRef(ref: string): boolean {
	return (
		/^\d+$/.test(ref) ||
		/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(ref)
	)
}
