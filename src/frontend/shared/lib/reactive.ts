// The reactive store kernel that replaces Alpine's reactivity: a deep proxy with
// the same mutation surface (`S.field = …`, nested writes, Set/Map/Array methods)
// and a module-level version counter. React subscribes to the version through
// useSyncExternalStore (see ./use-store-version.ts); everything below React keeps
// reading and mutating S exactly as before.
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

export function getStoreVersion(): number {
	return storeVersion
}

function bumpVersion(): void {
	storeVersion += 1
	for (const listener of listeners) listener()
}

export function subscribeStore(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

type UnknownFn = (...args: unknown[]) => unknown

const wrapperCache = new WeakMap<object, object>()
const proxies = new WeakSet()

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
function readValue(member: unknown, thisArg: object): unknown {
	if (typeof member === 'function') return (member as UnknownFn).bind(thisArg)
	return wrapValue(member)
}

// A mutating method call that bumps the version after the mutation settles.
function bumpingCall(method: UnknownFn, thisArg: object): UnknownFn {
	return (...args: unknown[]) => {
		const outcome = Reflect.apply(method, thisArg, args.map(unwrap))
		bumpVersion()
		return outcome
	}
}

function wrapValue(candidate: unknown): unknown {
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
		return readValue(Reflect.get(target, key, receiver), target)
	},
	set(target, key, written) {
		const previous = Reflect.get(target, key)
		const next = unwrap(written)
		const changed = !Object.is(previous, next)
		const accepted = Reflect.set(target, key, next)
		if (changed && accepted) bumpVersion()
		return accepted
	},
	deleteProperty(target, key) {
		const existed = Reflect.has(target, key)
		const accepted = Reflect.deleteProperty(target, key)
		if (existed && accepted) bumpVersion()
		return accepted
	},
}

const arrayHandler: ProxyHandler<unknown[]> = {
	...objectHandler,
	get(target, key, receiver) {
		const member = Reflect.get(target, key, receiver)
		if (typeof member !== 'function') return wrapValue(member)
		if (!mutatingCollectionMethods.has(String(key))) {
			return (member as UnknownFn).bind(target)
		}
		return bumpingCall(member as UnknownFn, target)
	},
}

const collectionHandler: ProxyHandler<Set<unknown> | Map<unknown, unknown>> = {
	...objectHandler,
	get(target, key, receiver) {
		const member = Reflect.get(target, key, receiver)
		if (typeof member !== 'function') return wrapValue(member)
		if (!mutatingCollectionMethods.has(String(key))) {
			return (member as UnknownFn).bind(target)
		}
		return bumpingCall(member as UnknownFn, target)
	},
}

// The one factory the app store uses. The generic documents the payload; the
// return type stays T so existing mutation code keeps type-checking unchanged.
// Subscription lives in subscribeStore (module level) - the React hook wires it,
// nothing on the store object itself.
export function reactive<T extends object>(target: T): T {
	return wrapValue(target) as T
}

export function isStoreProxy(candidate: unknown): boolean {
	return (
		typeof candidate === 'object' &&
		candidate !== null &&
		proxies.has(candidate)
	)
}
