import { useSyncExternalStore } from 'react'

import {
	getFieldVersion,
	getStoreVersion,
	subscribeStore,
	subscribeStoreFields,
} from './reactive'

// The React-side read seam for the reactive store. Components subscribe to the
// TOP-LEVEL fields they read (each store mutation bumps only its root field's
// version, so a poll writing S.agentActivity re-renders just the components
// reading that field), or to the global version when a view genuinely depends on
// everything. The diff body is not React at all (the engine owns it), so nothing
// hot rides this path.
//
// The store instance itself is reached through the bound context the component
// already uses (chromeCtx()/deskCtx()) - shared never imports @app.
export function useStoreVersion(): void {
	useSyncExternalStore(subscribeStore, getStoreVersion)
}

// One subscription for the whole field list. The snapshot sums the member fields'
// versions, which only ever increase - so the sum changes exactly when one of the
// fields does, and the component re-renders on precisely the mutations it reads.
export function useStoreFields(...fields: string[]): void {
	useSyncExternalStore(
		listener => subscribeStoreFields(fields, listener),
		() => fields.reduce((sum, field) => sum + getFieldVersion(field), 0),
	)
}
