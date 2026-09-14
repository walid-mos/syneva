import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The served UI assets sit next to the compiled server (dist/) in an install. Under `pnpm dev`
// the CLI runs from source via tsx, so __dirname is src/server/ - the esbuild bundle and the
// copied page still land in dist/, hence the process.cwd() fallbacks.
const COMPILED_ROOT = path.join(__dirname, '..')

// Resolve a UI asset against the built location first, then a dev fallback.
async function firstExisting(...candidates: string[]): Promise<string> {
	for (const candidate of candidates)
		if (await exists(candidate)) return candidate
	return candidates[0]
}

async function exists(file: string): Promise<boolean> {
	return await fs.stat(file).then(
		() => true,
		() => false,
	)
}

export async function uiBundlePath(): Promise<string> {
	return firstExisting(
		path.join(COMPILED_ROOT, 'ui.js'),
		path.join(process.cwd(), 'dist', 'ui.js'),
	)
}

export async function indexHtmlPath(): Promise<string> {
	return firstExisting(
		path.join(COMPILED_ROOT, 'index.html'),
		path.join(process.cwd(), 'src', 'ui', 'index.html'),
	)
}
