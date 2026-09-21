// The desk-lock record (~/.syneva/<repo hash>/<session>/desk.lock). Domain owns the shape
// and its decode: like the review records, it is persisted data whose bytes must be shaped
// field by field before anything trusts them - an unchecked cast would let a malformed or
// foreign lock file report a live desk, target an unintended URL, or produce misleading
// process-kill guidance.

export type DeskLock = {
	pid: number
	url: string
	session: string
	startedAt: string
}

const LOCK_FIELDS = ['pid', 'url', 'session', 'startedAt'] as const

// Explicit decode of a desk-lock JSON value. Returns null for anything that is not a
// complete, well-formed record: a truthy `url` alone proves nothing - the pid must be a
// positive integer and the three strings must be present, so a corrupt lock degrades to
// "no live desk" (never to a half-valid record with undefined fields).
export function decodeDeskLock(raw: unknown): DeskLock | null {
	if (typeof raw !== 'object' || raw === null) return null
	const record: Record<string, unknown> = Object.fromEntries(
		Object.entries(raw),
	)
	for (const field of LOCK_FIELDS) if (!(field in record)) return null
	const { pid, url, session, startedAt } = record
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
		return null
	if (typeof url !== 'string' || !url.length) return null
	if (typeof session !== 'string' || !session.length) return null
	if (typeof startedAt !== 'string' || !startedAt.length) return null
	return { pid, url, session, startedAt }
}
