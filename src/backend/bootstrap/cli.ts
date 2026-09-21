#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { SPEC } from '../../contracts/spec.js'
import { parseArgs } from '../adapters/inbound/cli/args.js'
import {
	runAwait,
	runComment,
	runReload,
	runStatus,
	runStop,
} from '../adapters/inbound/cli/commands.js'
import { runDesk } from '../adapters/inbound/cli/launch.js'
import { printLine, warn } from '../adapters/outbound/console.js'
import { currentVersion } from '../adapters/outbound/package-registry/update.js'

import type { CliArgs } from '../adapters/inbound/cli/args.js'

const HELP = `syneva - an integrated review environment (IRE) for code you didn't write by hand.

Usage:
  syneva [--diff working|staged]    Review the working-tree (default) or staged diff
  syneva file <path>                Review a single file or artifact (tracked or not)
  syneva pr <ref|number|url>        Review a branch's commits vs its merge-base
  syneva comment --path <f> --line <n> --body "..."   Post an agent reply into the desk
  syneva status --body "..."        Post an ephemeral "what I'm doing" line into the desk
  syneva await [--timeout <s>]      Block for the next desk event (question | review)
  syneva reload [--guide <file>]    Re-diff the working tree into the open desk
                                    (--guide swaps the attached review guide too)
  syneva stop [--session <id>|--all]  Stop this repo's live desk(s); idempotent
  syneva spec                       Print the full agent contract (modes, loop, ReviewResult, guide schema)

Common flags:
  --repo <path>     Repo to review (default: cwd)
  --session <id>    Review session id (default: branch / file-<path> / pr-<ref>)
  --port <n>        Server port (default: a stable per-session port (41000-50999))
  --host <addr>     Bind address (default: 127.0.0.1, loopback-only). Bind beyond loopback ONLY on a
                    fully trusted network - the desk API is unauthenticated (see README)
  --guide <file>    Attach an AI review guide (JSON)
  --idle-timeout <m>  Desk auto-exits after <m> minutes with no tab or agent (default 120; 0 = never)
  --no-open         Don't open the browser
  -h, --help        Show this help
  -v, --version     Show version

Env:
  SYNEVA_NO_UPDATE_CHECK=1   Skip the new-version check at desk start
  SYNEVA_HOST=<addr>         Default --host when the flag is absent
  SYNEVA_ALLOWED_HOSTS=a,b   Extra Host authorities to accept when bound beyond loopback

Docs: https://github.com/walid-mos/syneva`

// process.argv is [node, script, ...userArgs] - the CLI only ever sees the trailing args.
const USER_ARG_START_INDEX = 2

async function main(): Promise<void> {
	const argv = process.argv.slice(USER_ARG_START_INDEX)
	if (argv.includes('-v') || argv.includes('--version')) {
		printLine(currentVersion())
		return
	}
	if (argv[0] === 'help' || argv.includes('-h') || argv.includes('--help')) {
		printLine(HELP)
		return
	}
	const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : null
	const rest = sub ? argv.slice(1) : argv
	const positional =
		rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined
	await dispatch(sub, positional, parseArgs(rest))
}

async function dispatch(
	sub: string | null,
	positional: string | undefined,
	args: CliArgs,
): Promise<void> {
	switch (sub) {
		case 'comment':
			return runComment(args)
		case 'status':
			return runStatus(args)
		case 'await':
			return runAwait(args)
		case 'reload':
			return runReload(args)
		case 'stop':
			return runStop(args)
		case 'spec':
			printLine(SPEC)
			return
		case 'file':
			return runFile(positional, args)
		case 'pr':
			return runDesk('pr', positional, args)
		case null:
			return runDesk('repo', undefined, args)
		default:
			return unknownCommand(sub)
	}
}

async function runFile(
	positional: string | undefined,
	args: CliArgs,
): Promise<void> {
	if (!positional) {
		warn('Usage: syneva file <path>')
		process.exitCode = 1
		return
	}
	return runDesk('file', positional, args)
}

function unknownCommand(sub: string): void {
	warn(
		`Unknown command "${sub}". Use: syneva | syneva file <path> | syneva pr <ref|number|url> | comment | status | await | reload | stop | spec.`,
	)
	process.exitCode = 1
}

// An uncaught failure is reported as text: the stack names the failing frame; a thrown
// value that isn't an Error (or carries no stack) falls back to its message or String().
function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	if (error.stack) return error.stack
	return error.message
}

async function runMain(): Promise<void> {
	try {
		await main()
	} catch (error) {
		warn(errorText(error))
		process.exitCode = 1
	}
}

// Run only when executed as the bin (`syneva` / `node dist/backend/bootstrap/cli.js`), not when cli.test.ts
// imports this module to reach deskAlive() - otherwise import alone would launch a desk. npm
// installs the bin as a SYMLINK (.bin/syneva -> dist/backend/bootstrap/cli.js); Node resolves import.meta.url
// through the symlink to the real path, but leaves process.argv[1] as the symlink path - so
// argv[1] must be realpath'd before comparing, or the guard never fires under the published
// bin and the CLI silently no-ops. try/catch guards a dangling/unusual argv[1].
function isEntryPoint(): boolean {
	try {
		return (
			!!process.argv[1] &&
			import.meta.url ===
				pathToFileURL(realpathSync(process.argv[1])).href
		)
	} catch {
		return false
	}
}

if (isEntryPoint()) await runMain()
