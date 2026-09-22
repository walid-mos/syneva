// The reactive store kernel that replaces Alpine's reactivity: a deep proxy with
// the same mutation surface (`S.field = …`, nested writes, Set/Map/Array methods)
// and a two-level version counter. React subscribes either to the global version
// or - the normal case - to the top-level store fields a component reads
// (see ./use-store-version.ts); everything below React keeps reading and mutating
// S exactly as before.
//
// Attribution rule: every nested write is attributed to the ROOT store field it
// belongs to (the field of S the object was first reached through), so a poll
// writing S.agentActivity re-renders only the components subscribed to that field.
//
// Identity rule: wrappers are cached per target (WeakMap), so the same nested
// object always yields the same proxy - React memo and @pierre's element-identity
// checks stay stable across reads.
//
// The Proxy handlers wrap unknowns by design (that is the seam), so the type
// assertions here are the wrap/unwrap boundary and are lint-exempted for this
// file in oxlint.config.ts.

let storeVersion = 0
const listeners = new Set<() => void>()
const fieldVersions = new Map<string, number>()
const fieldListeners = new Map<string, Set<() => void>>()

// Sentinel root key for the store object itself: a set on S bumps the field key
// being written, never the sentinel.
const ROOT = '__store__'

export function getStoreVersion(): number {
	return storeVersion
}

export function getFieldVersion(field: string): number {
	return fieldVersions.get(field) ?? 0
}

function bumpVersion(field: string): void {
	storeVersion += 1
	fieldVersions.set(field, (fieldVersions.get(field) ?? 0) + 1)
	for (const listener of listeners) listener()
	const subscribed = fieldListeners.get(field)
	if (subscribed) for (const listener of subscribed) listener()
}

export function subscribeStore(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function subscribeStoreField(
	field: string,
	listener: () => void,
): () => void {
	let subscribed = fieldListeners.get(field)
	if (!subscribed) {
		subscribed = new Set()
		fieldListeners.set(field, subscribed)
	}
	subscribed.add(listener)
	return () => subscribed.delete(listener)
}

type UnknownFn = (...args: unknown[]) => unknown

const wrapperCache = new WeakMap<object, object>()
const proxies = new WeakSet()
// Each wrapped object remembers the ROOT store field it hangs from, so a nested
// write can be attributed (see the attribution rule above).
const rootFields = new WeakMap<object, string>()

// Methods whose invocation mutates the collection they belong to - each one must
// bump the version so subscribers re-render.
const mutatingCollectionMethods = new Set([
	'add',
	'delete',
	'clear',
	'set',
	'push',
	'pop',
	'shift',
	'unshift',
	'splice',
	'sort',
	'reverse',
	'fill',
])

// A read of a store path: raw targets become their cached wrappers; functions stay
// bound to their raw object (wrapping a function would break its `this`).
function readValue(member: unknown, thisArg: object, field: string): unknown {
	if (typeof member === 'function') return (member as UnknownFn).bind(thisArg)
	return wrapValue(member, field)
}

// A mutating method call that bumps the version after the mutation settles.
function bumpingCall(method: UnknownFn, thisArg: object, field: string): UnknownFn {
	return (...args: unknown[]) => {
		const outcome = Reflect.apply(method, thisArg, args.map(unwrap))
		bumpVersion(field)
		return outcome
	}
}

function wrapValue(candidate: unknown, field: string): unknown {
	if (typeof candidate !== 'object' || candidate === null) return candidate
	const cached = wrapperCache.get(candidate)
	if (cached) return cached
	let proxy: object
	if (Array.isArray(candidate)) {
		proxy = new Proxy(candidate, arrayHandler)
	} else if (candidate instanceof Set || candidate instanceof Map) {
		proxy = new Proxy(candidate, collectionHandler)
	} else {
		proxy = new Proxy(candidate, objectHandler)
	}
	wrapperCache.set(candidate, proxy)
	rootFields.set(candidate, field)
	proxies.add(proxy)
	return proxy
}

// A write of an already-wrapped value stores the raw target, so identity
// comparisons inside the store never hit proxies.
function unwrap(candidate: unknown): unknown {
	if (typeof candidate !== 'object' || candidate === null) return candidate
	const raw = wrapperCache.get(candidate)
	if (raw) return raw
	return candidate
}

const objectHandler: ProxyHandler<object> = {
	get(target, key, receiver) {
		if (key === '__isStoreProxy') return true
		// At the store root the KEY being read is the field; below it, the parent's
		// root field carries the attribution down the whole branch.
		const field =
			rootFields.get(target) === ROOT ? String(key) : (rootFields.get(target) ?? ROOT)
		return readValue(Reflect.get(target, key, receiver), target, field)
	},
	set(target, key, written) {
		const previous = Reflect.get(target, key)
		const next = unwrap(written)
		const changed = !Object.is(previous, next)
		const accepted = Reflect.set(target, key, next)
		if (changed && accepted) {
			bumpVersion(rootFields.get(target) === ROOT ? String(key) : (rootFields.get(target) as string))
		}
		return accepted
	},
	deleteProperty(target, key) {
		const existed = Reflect.has(target, key)
		const accepted = Reflect.deleteProperty(target, key)
		if (existed && accepted) {
			bumpVersion(rootFields.get(target) === ROOT ? String(key) : (rootFields.get(target) as string))
		}
		return accepted
	},
}

const arrayHandler: ProxyHandler<unknown[]> = {
	...objectHandler,
	get(target, key, receiver) {
		const member = Reflect.get(target, key, receiver)
		if (typeof member !== 'function') return wrapValue(member, rootFields.get(target) ?? ROOT)
		if (!mutatingCollectionMethods.has(String(key))) {
			return (member as UnknownFn).bind(target)
		}
		return bumpingCall(
			member as UnknownFn,
			target,
			rootFields.get(target) ?? ROOT,
		)
	},
}

const collectionHandler: ProxyHandler<Set<unknown> | Map<unknown, unknown>> = {
	...objectHandler,
	get(target, key, receiver) {
		const member = Reflect.get(target, key, receiver)
		if (typeof member !== 'function') return wrapValue(member, rootFields.get(target) ?? ROOT)
		if (!mutatingCollectionMethods.has(String(key))) {
			return (member as UnknownFn).bind(target)
		}
		return bumpingCall(
			member as UnknownFn,
			target,
			rootFields.get(target) ?? ROOT,
		)
	},
}

// The one factory the app store uses. The generic documents the payload; the
// return type stays T so existing mutation code keeps type-checking unchanged.
// Subscription lives in subscribeStore/subscribeStoreField (module level) - the
// React hook wires it, nothing on the store object itself.
export function reactive<T extends object>(target: T): T {
	const proxy = wrapValue(target, ROOT) as T
	return proxy
}

export function isStoreProxy(candidate: unknown): boolean {
	return typeof candidate === 'object' && candidate !== null && proxies.has(candidate)
}
