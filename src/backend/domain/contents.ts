export type FileContents = { oldContents: string; newContents: string }

// The exact text of the line a comment anchors to, from the file's on-demand contents (additions
// side = new file, deletions side = old file). Pure - the caller fetches the one file's contents
// (readFileContents in backend/application/contents.ts) since the state no longer embeds them.
// Captured at comment creation; re-anchoring matches against it after the agent's edits move
// things around.
export function anchorTextFor(
	contents: FileContents | undefined,
	side: 'additions' | 'deletions',
	lineNumber: number,
): string | undefined {
	const text =
		side === 'deletions' ? contents?.oldContents : contents?.newContents
	return text?.split('\n')[lineNumber - 1]
}
