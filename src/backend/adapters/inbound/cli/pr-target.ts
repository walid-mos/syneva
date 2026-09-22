import { warn } from '../../outbound/console.js'
import { gh, git } from '../../outbound/git/exec.js'

import { isPrRef } from './args.js'

import type { ReviewMode } from '../../../../contracts/review.js'
import type { CliArgs } from './args.js'

export type PrTarget = { target: string | undefined; base: string | undefined }
type PrInfo = { headRefName: string; baseRefName: string }

// PR mode targets a branch by default; a numeric ref or GitHub PR URL is resolved to its
// head/base branches via the GitHub CLI. Non-PR modes pass the target through untouched.
export async function resolvePrTarget(
	mode: ReviewMode,
	target: string | undefined,
	args: CliArgs,
	root: string,
): Promise<PrTarget | null> {
	const base =
		mode === 'pr' && typeof args.base === 'string' ? args.base : undefined
	if (mode !== 'pr' || !target) return { target, base }
	const dirty = await git(
		['status', '--porcelain', '--untracked-files=no'],
		root,
	).catch(() => '')
	if (dirty.trim()) {
		warn(
			`Working tree has uncommitted changes to tracked files - commit or stash before reviewing a PR (no checkout performed):\n${dirty}`,
		)
		process.exitCode = 1
		return null
	}
	if (isPrRef(target)) return resolvePrNumber(target, root, base)
	return checkoutBranch(target, root, base)
}

async function resolvePrNumber(
	ref: string,
	root: string,
	base: string | undefined,
): Promise<PrTarget | null> {
	try {
		const prInfo = await fetchPrInfo(ref, root)
		await gh(['pr', 'checkout', ref], root)
		return {
			target: prInfo.headRefName,
			base: base ?? (await resolveRemoteBase(prInfo.baseRefName, root)),
		}
	} catch (error) {
		warn(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
		return null
	}
}

async function fetchPrInfo(ref: string, root: string): Promise<PrInfo> {
	let raw: string
	try {
		raw = await gh(
			['pr', 'view', ref, '--json', 'headRefName,baseRefName'],
			root,
		)
	} catch (error) {
		throw new Error(
			`Could not resolve PR "${ref}" via the GitHub CLI. Install gh and run \`gh auth login\`, or pass a branch name instead.\n${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		)
	}
	const prInfo = readPrInfo(JSON.parse(raw))
	if (!prInfo)
		throw new Error(`PR "${ref}" did not resolve to a head/base branch.`)
	return prInfo
}

// `gh pr checkout` updates HEAD but never refreshes the base branch, so a merge-base against a
// stale local base makes a long-lived PR show unrelated mainline commits. Refresh the base ref
// and prefer the remote-tracking tip, matching GitHub's three-dot "Files changed". Best-effort:
// offline / a fork base not on `origin` falls back to the bare branch name. --quiet keeps
// rev-parse from printing on the miss path.
async function resolveRemoteBase(
	baseRefName: string,
	root: string,
): Promise<string> {
	await git(['fetch', 'origin', baseRefName], root).catch(() => undefined)
	const remoteBase = `origin/${baseRefName}`
	try {
		await git(['rev-parse', '--verify', '--quiet', remoteBase], root)
		return remoteBase
	} catch {
		return baseRefName
	}
}

function readPrInfo(parsed: unknown): PrInfo | null {
	if (typeof parsed !== 'object' || parsed === null) return null
	if (!('headRefName' in parsed) || typeof parsed.headRefName !== 'string')
		return null
	if (!('baseRefName' in parsed) || typeof parsed.baseRefName !== 'string')
		return null
	return { headRefName: parsed.headRefName, baseRefName: parsed.baseRefName }
}

async function checkoutBranch(
	target: string,
	root: string,
	base: string | undefined,
): Promise<PrTarget | null> {
	try {
		await git(['checkout', target], root)
		return { target, base }
	} catch (error) {
		warn(
			`Could not check out "${target}": ${error instanceof Error ? error.message : String(error)}`,
		)
		process.exitCode = 1
		return null
	}
}
