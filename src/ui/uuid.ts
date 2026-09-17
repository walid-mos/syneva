// crypto.randomUUID() is secure-context-gated: on a plain-HTTP non-localhost origin
// (SYNEVA_HOST/tailnet desks, e.g. http://devbox:41443/) it's undefined and comment creation
// would throw. crypto.getRandomValues() has no such gate, so build an RFC-4122 v4 UUID from it
// when the native call isn't available - same shape as native, no Math.random fallback.

// RFC 4122 layout: 16 random bytes rendered as 8-4-4-4-12 lowercase hex digits.
const UUID_BYTE_COUNT = 16
const VERSION_BYTE_INDEX = 6
const VARIANT_BYTE_INDEX = 8
const VERSION_NIBBLE_MASK = 0x0f
const VERSION_4_NIBBLE = 0x40
const VARIANT_NIBBLE_MASK = 0x3f
const VARIANT_10XX_NIBBLE = 0x80
const HEX_RADIX = 16
const HEX_PAD_WIDTH = 2
const GROUP_END = { first: 8, second: 12, third: 16, fourth: 20 } as const

function hexOf(bytes: Uint8Array): string {
	return Array.from(bytes, byte =>
		byte.toString(HEX_RADIX).padStart(HEX_PAD_WIDTH, '0'),
	).join('')
}

function group(hex: string): string {
	const { first, second, third, fourth } = GROUP_END
	return `${hex.slice(0, first)}-${hex.slice(first, second)}-${hex.slice(second, third)}-${hex.slice(third, fourth)}-${hex.slice(fourth)}`
}

export function uuidFallback(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(UUID_BYTE_COUNT))
	bytes[VERSION_BYTE_INDEX] =
		(bytes[VERSION_BYTE_INDEX] & VERSION_NIBBLE_MASK) | VERSION_4_NIBBLE
	bytes[VARIANT_BYTE_INDEX] =
		(bytes[VARIANT_BYTE_INDEX] & VARIANT_NIBBLE_MASK) | VARIANT_10XX_NIBBLE
	return group(hexOf(bytes))
}

export function uuid(): string {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: uuidFallback()
}
