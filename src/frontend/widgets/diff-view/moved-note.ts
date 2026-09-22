import { $ } from '@shared/lib/dom'
import { esc } from '@shared/lib/esc'

import type { ReviewFile } from '@entities/review/model'

// The muted one-line note for a pure rename. render() calls this instead of the @pierre
// diff when a moved-pure file is opened. The caller passes the file and its old path
// (see file/renames.ts movedFrom).
export function renderMovedPure(file: ReviewFile, from: string): void {
	$('diff').innerHTML =
		`<div class="file-note"><div class="file-note-strip moved">
    <svg class="ic"><use href="#gly-arrow-right"></use></svg>
    <span>renamed <span class="file-note-name">${esc(from)}</span> → <span class="file-note-name">${esc(file.path)}</span></span>
    <span class="file-note-meta">no changes</span>
  </div></div>`
}
