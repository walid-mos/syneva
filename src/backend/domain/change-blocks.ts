import type { ChangeState, DiffFile } from './review.js'

// The reviewed path: the new path, or the old one for a full deletion, or a placeholder for a
// malformed section that carries neither (the UI shows it but no mode can read its sides).
export function filePathOf(file: DiffFile): string {
	return file.newPath ?? file.oldPath ?? 'unknown'
}

// A change block's decision key, and the id the UI groups it by: `${path}:${stableKey}`.
export function changeKey(change: ChangeState): string {
	return `${change.path}:${change.stableKey}`
}
