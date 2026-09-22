// Shared decode primitives for the persisted-file DTOs (review-file-dto.ts and
// diff-envelope-dto.ts): every decoded value is produced by one of these allowlist
// decoders - never cast - so unknown or malformed JSON data can never enter the live
// review state. The format is frozen: newer desk runs read older files (missing
// optionals decode to their defaults) and older runs keep reading newer records
// (unknown fields are dropped, not rejected).
//
// Required-field decoders return null (not undefined) when the JSON value is absent or
// of the wrong kind: a required-field guard then compares against null, which keeps
// legitimate falsy values (empty string, 0) distinguishable from absence. Optional
// fields map through `?? undefined` onto their optional domain slot.

export type Raw = Record<string, unknown>

// The one entry gate from untyped JSON onto a typed record. A generic runtime guard is a
// deliberate low-level exception here: this is the storage DTO's decode primitive, and the
// allowlist decoders below do the schema validation field by field.
// oxlint-disable-next-line nextnode/no-generic-runtime-guard
export function isObject(raw: unknown): raw is Raw {
	return typeof raw === 'object' && raw !== null
}

// ── required-field decoders (null on absence/wrong kind) ────────────────────────

export function asString(raw: unknown): string | null {
	if (typeof raw === 'string') return raw
	return null
}

export function asNumber(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw
	return null
}

export function asBoolean(raw: unknown): boolean | null {
	if (typeof raw === 'boolean') return raw
	return null
}

export function asOneOf<T extends string>(
	raw: unknown,
	allowed: readonly T[],
): T | null {
	return allowed.find(option => option === raw) ?? null
}
