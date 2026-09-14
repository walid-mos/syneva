import type { OxfmtConfig } from 'oxfmt'

// The shared preset ships its oxfmt options as a plain object literal, so TypeScript widens
// enum-like values (`arrowParens: string`) and spreading it into `oxfmt`'s `defineConfig` fails
// with TS2345 - even though the preset's `base.js` is exactly the shape `OxfmtConfig` describes.
// `tsconfig.tooling.json` maps the preset specifier here so the config files are type-checked
// against the real contract instead of silencing the error with an `as` assertion.
// `ignorePatterns` is required (not optional as in `OxfmtConfig`): the preset always ships it and
// oxfmt.config.ts spreads it before layering the repo-local patterns on top.
declare const config: OxfmtConfig & { ignorePatterns: string[] }
export default config
