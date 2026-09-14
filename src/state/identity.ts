import crypto from 'node:crypto'

// Hex chars kept from the sha256 digest: enough to key a per-repo review dir and to derive a port,
// short enough to stay readable inside a path. The slice length and the radix parseInt reads the
// port seed with are the two numeric inputs of every derived id below.
const HASH_LENGTH = 16
const PORT_SEED_LENGTH = 8
const HEX_RADIX = 16

// Deterministic per-repo+session port range (41000-50999), the base of stablePort's hash.
const PORT_BASE = 41_000
const PORT_RANGE = 10_000

export function nowIso(): string {
	return new Date().toISOString()
}

export function hash(text: string): string {
	return crypto
		.createHash('sha256')
		.update(text)
		.digest('hex')
		.slice(0, HASH_LENGTH)
}

// A session name safe as one path segment: anything outside [A-Za-z0-9._-] collapses to '-', so
// `--session "pr 123/foo"` can never escape the review dir. A name that cleans away to nothing
// (`--session "///"`) still names a desk, so it falls back to a fixed default.
export function sanitizeSession(session: string): string {
	const cleaned = session
		.replace(/[^a-zA-Z0-9._-]/g, '-')
		.replace(/^-+|-+$/g, '')
	return cleaned || 'review'
}

// Deterministic per-repo+session port. A restarted desk binds the same origin, so an already-open
// tab self-heals through its state poll instead of dying on a dead random port. Collisions with
// foreign processes fall back to a random port at listen time (startDeskPort in cli/desk-serve).
export function stablePort(root: string, session: string): number {
	const seed = hash(`${root}:${sanitizeSession(session)}`).slice(
		0,
		PORT_SEED_LENGTH,
	)
	return PORT_BASE + (parseInt(seed, HEX_RADIX) % PORT_RANGE)
}
