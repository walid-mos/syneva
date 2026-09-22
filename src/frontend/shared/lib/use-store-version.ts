import { useSyncExternalStore } from 'react'

import {
	getFieldVersion,
	getStoreVersion,
	subscribeStore,
	subscribeStoreField,
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

export function useStoreFields(...fields: string[]): void {
	for (const field of fields) {
		// One hook call per field keeps the hook order stable (fields are static
		// literals at each call site).
		// eslint-disable-next-line react-hooks/rules-of-hooks -- static list
		useSyncExternalStore(
			listener => subscribeStoreField(field, listener),
			() => getFieldVersion(field),
		)
	}
}
