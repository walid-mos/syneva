import { hasGuide } from './guide'
import { S } from './store'

// ── Keyboard map vocabulary ──────────────────────────────────────────────────
// The matchers and scope guards every binding is written in: one place decides what a keydown
// means and which surface is up, so an entry states its key and its scope instead of repeating
// modifier checks. keys.ts owns the dispatcher and the ? overlay; hotkeys-*.ts own the entries.

export type Group = 'Navigate' | 'Review' | 'Comment' | 'View' | 'App'
/** Did this keydown press the key a binding is for? */
export type KeyMatcher = (e: KeyboardEvent) => boolean
/** What a binding does when it wins: synchronous, so async work is detached (see keys.ts). */
export type KeyAction = (e: KeyboardEvent) => void

export type Hotkey = {
	combo: string
	desc: string
	group: Group
	test: KeyMatcher
	run: KeyAction
	when?: () => boolean // scope guard (default: anywhere not typing)
	typing?: boolean // also fires while typing in the composer
	hide?: boolean // omit from the help overlay
	goline?: boolean // part of the go-to-line gesture - doesn't cancel a pending digit buffer
}

// Scopes: which surface is up. `inDiff` is the diff itself - no composer, modal or Overview.
export const inComposer = (): boolean => S.composerOpen
export const inModal = (): boolean =>
	S.settingsOpen || !!S.confirmMsg || S.sendOpen
export const inOverview = (): boolean => S.overviewOpen && hasGuide()
export const inDiff = (): boolean =>
	!inComposer() && !inModal() && !inOverview()
export const navigable = (): boolean => !inComposer() && !inModal()
export const isMd = (): boolean => inDiff() && !!S.isMarkdownFile?.()

// Key matchers. `key` is the bare key; `enter` the bare Enter - the ⇧/⌘/⌘⇧ variants have their own.
export const key =
	(name: string): KeyMatcher =>
	(e: KeyboardEvent): boolean =>
		e.key === name && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
export const enter: KeyMatcher = (e: KeyboardEvent): boolean =>
	e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
export const shift =
	(name: string): KeyMatcher =>
	(e: KeyboardEvent): boolean =>
		e.key === name && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
export const cmd =
	(name: string): KeyMatcher =>
	(e: KeyboardEvent): boolean =>
		e.key === name && (e.metaKey || e.ctrlKey) && !e.shiftKey
export const cmdShift =
	(name: string): KeyMatcher =>
	(e: KeyboardEvent): boolean =>
		e.key === name && (e.metaKey || e.ctrlKey) && e.shiftKey
