import { bindFeatureCtx } from '@features/context'
import { cursorSelection, cursorSyncTo } from '@widgets/diff-view/cursor'
import { D } from '@widgets/diff-view/runtime'

import { persist, requireState, S, toast } from './store'

// Bind the features-layer seam (features/context.ts) once, at composition. Feature actions
// read the reactive store proxy and the imperative island's read-only bits through this narrow
// context instead of importing the store or the diff widget modules - the one place the app
// couples features to them. Must run before the first keypress/comment action (any
// featureCtx() read throws until it is bound).
export function bindFeaturePorts(): void {
	bindFeatureCtx({
		S,
		requireState,
		persist,
		toast,
		fileDiff: () => D.fileDiff,
		lineMap: () => D.lineMap,
		diffInstance: () => D.instance,
		cursorSyncTo,
		cursorSelection,
	})
}
