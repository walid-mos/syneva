// Every content read - a working-tree `readFile` or a `git show` spawn - holds a file descriptor,
// and one build can touch thousands of files. An unbounded `Promise.all` over them exhausts the
// process's descriptor budget (macOS defaults to 256, and a constrained shell can be far lower): the
// reads that lose the race fail, and because a missing side deliberately degrades to "" instead of
// throwing, the review silently comes out wrong - the deletion/OID pairing stops resolving and a
// 100-file sweep renders 101 rows. Four in flight keeps the reads warm without holding more than a
// handful of handles at once.
export const CONTENT_READ_LIMIT = 4

// Map `read` over `items`, keeping at most CONTENT_READ_LIMIT reads in flight. Results keep the
// input order, so callers that index into them - or that rely on diff order - are unaffected.
export async function mapContentReads<Item, Mapped>(
	items: readonly Item[],
	read: (item: Item, index: number) => Promise<Mapped>,
): Promise<Mapped[]> {
	const results: Mapped[] = []
	let next = 0
	const worker = async (): Promise<void> => {
		const index = next
		if (index >= items.length) return
		next++
		results[index] = await read(items[index], index)
		return worker()
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(CONTENT_READ_LIMIT, items.length) },
			worker,
		),
	)
	return results
}
