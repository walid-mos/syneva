// Decoding primitives for the entity API boundaries: mechanics only - object/array
// recognition, required/optional scalar fields, enum membership. Domain knowledge
// (which fields an endpoint carries, what to do on absence) stays in the boundary
// mappers; these helpers just fail loudly with a named cause when the wire lies.

// A decode failure: the response was 2xx but not the shape the endpoint promises.
export class DecodeError extends Error {
	constructor(
		message: string,
		readonly endpoint: string,
	) {
		super(message)
		this.name = 'DecodeError'
	}
}

// Narrowing predicates over the wire: keep every decode path free of `as` casts.
// A generic runtime guard is a deliberate low-level exception here: this is the shared
// HTTP decode primitive, and the entity boundary mappers validate field by field.
// oxlint-disable-next-line nextnode/no-generic-runtime-guard
function isWireObject(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

function isWireEnum<T extends string>(
	raw: unknown,
	allowed: readonly T[],
): raw is T {
	return allowed.some(option => option === raw)
}

export function assertObject(
	raw: unknown,
	endpoint: string,
	what = 'response',
): Record<string, unknown> {
	if (!isWireObject(raw))
		throw new DecodeError(`${what} is not an object`, endpoint)
	return raw
}

export function requiredString(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): string {
	const v = obj[key]
	if (typeof v !== 'string')
		throw new DecodeError(`${key} is not a string`, endpoint)
	return v
}

export function requiredNumber(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): number {
	const v = obj[key]
	if (typeof v !== 'number' || !Number.isFinite(v))
		throw new DecodeError(`${key} is not a finite number`, endpoint)
	return v
}

export function requiredBoolean(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): boolean {
	const v = obj[key]
	if (typeof v !== 'boolean')
		throw new DecodeError(`${key} is not a boolean`, endpoint)
	return v
}

export function requiredArray(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
	what = key,
): unknown[] {
	const v = obj[key]
	if (!Array.isArray(v))
		throw new DecodeError(`${what} is not an array`, endpoint)
	return v
}

export function requiredStringArray(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): string[] {
	return requiredArray(obj, key, endpoint).map(v => {
		if (typeof v !== 'string')
			throw new DecodeError(
				`${key} must be an array of strings`,
				endpoint,
			)
		return v
	})
}

// An optional field: absent/undefined passes through as undefined, a present value
// must satisfy the check. Unknown fields are ignored by construction - callers copy
// only what they read.
export function optional<T>(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
	check: (v: unknown) => T,
): T | undefined {
	if (!(key in obj) || obj[key] === undefined) return undefined
	return check(obj[key])
}

export function optString(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): string | undefined {
	return optional(obj, key, endpoint, v => {
		if (typeof v !== 'string')
			throw new DecodeError(`${key} is not a string`, endpoint)
		return v
	})
}

export function optNumber(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): number | undefined {
	return optional(obj, key, endpoint, v => {
		if (typeof v !== 'number' || !Number.isFinite(v))
			throw new DecodeError(`${key} is not a finite number`, endpoint)
		return v
	})
}

export function optBoolean(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
): boolean | undefined {
	return optional(obj, key, endpoint, v => {
		if (typeof v !== 'boolean')
			throw new DecodeError(`${key} is not a boolean`, endpoint)
		return v
	})
}

// Enum membership: a present value must be one of the allowed literals.
export function optEnum<T extends string>(
	obj: Record<string, unknown>,
	key: string,
	endpoint: string,
	allowed: readonly T[],
): T | undefined {
	return optional(obj, key, endpoint, v => {
		if (!isWireEnum(v, allowed))
			throw new DecodeError(
				`${key} must be one of: ${allowed.join(' | ')}`,
				endpoint,
			)
		return v
	})
}

export function stringArray(raw: unknown, endpoint: string): string[] {
	if (!Array.isArray(raw))
		throw new DecodeError('expected an array of strings', endpoint)
	return raw.map(v => {
		if (typeof v !== 'string')
			throw new DecodeError('expected an array of strings', endpoint)
		return v
	})
}

export function enumValue<T extends string>(
	raw: unknown,
	endpoint: string,
	allowed: readonly T[],
	what: string,
): T {
	if (isWireEnum(raw, allowed)) return raw
	throw new DecodeError(
		`${what} must be one of: ${allowed.join(' | ')}`,
		endpoint,
	)
}
