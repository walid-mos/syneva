// A minimal in-process serialization queue: a promise-chain mutex. `serialize(fn)` runs `fn`
// only after every previously enqueued task has settled, so tasks execute one at a time in
// enqueue order. Enqueue order (not completion order) is what determines the run order, so the
// caller must enqueue synchronously to get a guaranteed sequence.
//
// A rejected task settles the chain WITHOUT poisoning it: the queue's tail promise only tracks
// completion, so the next task still runs, while the promise handed back to the caller still
// rejects - the caller sees its own failure.
export type Serializer = <T>(fn: () => Promise<T>) => Promise<T>

export function createSerializer(): Serializer {
	let tail: Promise<void> = Promise.resolve()
	return serialize

	async function serialize<T>(fn: () => Promise<T>): Promise<T> {
		const previous = tail
		const outcome = runAfter(previous, fn)
		tail = trackCompletion(outcome)
		return outcome
	}
}

async function runAfter<T>(
	previous: Promise<void>,
	fn: () => Promise<T>,
): Promise<T> {
	await previous
	return fn()
}

async function trackCompletion(outcome: Promise<unknown>): Promise<void> {
	try {
		await outcome
	} catch {
		// The caller owns `fn`'s rejection; the queue only needs completion.
	}
}
