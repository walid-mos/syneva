// The curated Shiki theme set, deep-imported so only these themes are bundled. Consumed by BOTH
// markdown.ts (comment/file fenced code) and shiki-shim.ts (the diff view via @pierre/diffs) - one
// theme set styles both surfaces. Deep-imported from shiki/dist/themes so no extra JSON rides the
// bundle; the theme names match the settings picker, so switching a theme restyles both surfaces.
import ayuDark from 'shiki/dist/themes/ayu-dark.mjs'
import catppuccinLatte from 'shiki/dist/themes/catppuccin-latte.mjs'
import darkPlus from 'shiki/dist/themes/dark-plus.mjs'
import dracula from 'shiki/dist/themes/dracula.mjs'
import everforest from 'shiki/dist/themes/everforest-dark.mjs'
import everforestLight from 'shiki/dist/themes/everforest-light.mjs'
import githubDark from 'shiki/dist/themes/github-dark.mjs'
import githubLight from 'shiki/dist/themes/github-light.mjs'
import gruvbox from 'shiki/dist/themes/gruvbox-dark-medium.mjs'
import lightPlus from 'shiki/dist/themes/light-plus.mjs'
import materialDarker from 'shiki/dist/themes/material-theme-darker.mjs'
import palenight from 'shiki/dist/themes/material-theme-palenight.mjs'
import oneLight from 'shiki/dist/themes/one-light.mjs'
import vitesseLight from 'shiki/dist/themes/vitesse-light.mjs'

import type { ThemeRegistration } from 'shiki/core'

// Keyed by theme name (matches the settings picker). Diff-only themes (pierre-*) aren't here -
// @pierre/diffs registers those itself as custom CSS-variable themes. Record<string,
// ThemeRegistration> is both what shiki's createHighlighterCore takes for `themes` and what the
// lookups below (resolveTheme, shiki-shim's bundledThemes) index with a settings name.
export const CURATED_THEMES: Record<string, ThemeRegistration> = {
	'material-theme-palenight': palenight,
	'material-theme-darker': materialDarker,
	'github-dark': githubDark,
	dracula: dracula,
	'ayu-dark': ayuDark,
	'gruvbox-dark-medium': gruvbox,
	'everforest-dark': everforest,
	'dark-plus': darkPlus,
	// Light code themes - the settings picker groups these under "Light"; the code theme is
	// independent of the chrome appearance, so any of them can pair with either mode.
	// (These ~170 KB of theme JSON are why the bundle gate moved 3.2 → 3.3 MB.)
	'github-light': githubLight,
	'one-light': oneLight,
	'vitesse-light': vitesseLight,
	'catppuccin-latte': catppuccinLatte,
	'everforest-light': everforestLight,
	'light-plus': lightPlus,
}
