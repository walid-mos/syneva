import { useSyncExternalStore } from 'react'

import { getStoreVersion, subscribeStore } from './reactive'

// The React-side read seam for the reactive store: subscribe to the store
// version (any mutation anywhere bumps it) and re-render. Chrome DOM is small,
// so a coarse subscription is the honest primitive; the diff body is not React
// at all (the engine owns it), so nothing hot rides this path.
//
// The store instance itself is reached through the bound context the component
// already uses (chromeCtx()/deskCtx()) - shared never imports @app.
export function useStoreVersion(): void {
	useSyncExternalStore(subscribeStore, getStoreVersion)
}
