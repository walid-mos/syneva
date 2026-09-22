import { chromeCtx } from './context'

// Sidebar DOM chrome shared by both source trees (tree.ts data, walkthrough.ts data): the
// body-level layout classes and the "active" row highlight. Both used to live in tree.ts -
// pure imperative patches, no source-tree deps.

// Layout classes were toggled inside the old sync(); render() calls this now.
export function applyLayoutClasses(): void {
	document.body.classList.toggle(
		'single',
		(chromeCtx().S.state?.files.length ?? 0) <= 1,
	)
	document.body.classList.toggle(
		'file-mode',
		chromeCtx().S.state?.mode === 'file',
	)
}

// The sidebar's "active" highlight, patched in place instead of derived in the row models.
// Deriving it made treeRows()/walkthroughRows(GI()) depend on chromeCtx().S.fileIndex/chromeCtx().S.preview/chromeCtx().S.overviewOpen,
// so every file switch re-ran both x-fors - thousands of row bindings re-evaluated to move one
// highlight (the dominant per-switch cost on big desks). Same pattern as updateAwaitingDom:
// selectFile calls this directly, and render() re-applies it after Alpine's flush (an rAF later,
// so freshly re-keyed rows get the class back - Alpine's :class diff only removes classes it
// added itself, so this manual class survives binding re-evaluation on reused elements).
export function applyActiveRow(): void {
	for (const el of document.querySelectorAll(
		'#files .node.active, #walk .node.active',
	))
		el.classList.remove('active')
	// No file is "active" on the Overview; a previewed file wins over the indexed review file.
	if (chromeCtx().S.overviewOpen) return
	const path =
		chromeCtx().S.preview?.path ??
		chromeCtx().S.state?.files.at(chromeCtx().S.fileIndex)?.path ??
		null
	if (!path) return
	for (const key of [`file:${path}`, `test:${path}`])
		for (const el of document.querySelectorAll(
			`.node[data-key="${CSS.escape(key)}"]`,
		))
			el.classList.add('active')
}
