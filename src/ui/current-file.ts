// Which file the diff shows, given the store's three inputs. Pure and injected, so the pre-init
// window (no review yet) and an emptied review (a reload that removed every file) are unit-testable
// without the Alpine store - changes.ts is the store-reading wrapper.
export function pickCurrentFile<File>(
	files: readonly File[] | undefined,
	preview: File | null,
	fileIndex: number,
): File | null {
	// A preview (an unchanged file the reviewer opened to read/comment on) always wins.
	return preview ?? files?.[fileIndex] ?? null
}
