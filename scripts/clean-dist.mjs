// The published package ships the whole of dist (see "files" in package.json),
// so every build must start from an empty dist: leftover artifacts from an
// earlier build layout would otherwise survive (tsc/esbuild never delete
// removed outputs) and be packed. tsc and esbuild recreate dist afterwards;
// `pnpm dev` watch rebuilds go through build-ui.mjs, which cleans only its
// hashed chunks between watch restarts.
import { rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
