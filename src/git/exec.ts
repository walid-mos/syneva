import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const KIB = 1024
const MIB = KIB * KIB
const MAX_BUFFER_MIB = 256

// Cap on a single git/gh stdout. Generous because a whole-PR `git diff` or a `git show` of a large
// generated/vendored file can be big; exceeding it rejects (git()) or degrades a file to a spurious
// full add/delete (fileAt swallows the error), so a too-small cap silently corrupts a large diff.
export const MAX_BUFFER = MAX_BUFFER_MIB * MIB

// `core.quotePath` defaults to true, so any path with a non-ASCII byte comes back C-quoted and
// wrapped in double quotes (café.txt → "caf\303\251.txt"), which the diff parser and every path
// consumer downstream then mangle. Disabling it via `-c` here - the one wrapper git.ts and state.ts
// both spawn git through - makes every invocation (diff builders, rawBlobOids, ls-files --others,
// diff --cached --name-only, …) emit raw UTF-8 paths, in one place. It's a no-op for commands that
// emit no paths, so applying it globally is safe rather than per-call-site (which could miss one).
export async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		'git',
		['-c', 'core.quotePath=false', ...args],
		{
			cwd,
			maxBuffer: MAX_BUFFER,
		},
	)
	return stdout.trimEnd()
}

// Thin wrapper around the GitHub CLI, used only to resolve a PR number/URL to its branch.
// Kept optional: callers catch failures (gh missing or unauthenticated) and report them.
export async function gh(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('gh', args, {
		cwd,
		maxBuffer: MAX_BUFFER,
	})
	return stdout.trimEnd()
}

export async function runGitRaw(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd,
		maxBuffer: MAX_BUFFER,
	})
	return stdout
}
