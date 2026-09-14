import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { warn } from '../output.js'

import type { Server } from 'node:http'

const execFileAsync = promisify(execFile)

// Prefer the requested (stable per-session) port; if a foreign process holds it,
// fall back to a random one rather than failing the launch.
export async function listenOn(
	server: Server,
	port: number,
	host: string,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			if (
				port !== 0 &&
				(error.code === 'EADDRINUSE' || error.code === 'EACCES')
			) {
				warn(`Port ${port} is taken - falling back to a random port.`)
				server.removeListener('error', onError)
				server.listen(0, host, resolve)
			} else reject(error)
		}
		server.once('error', onError)
		server.listen(port, host, () => {
			server.removeListener('error', onError)
			resolve()
		})
	})
}

// Open the desk in the reviewer's browser. Best-effort on purpose: a machine with no opener (a
// container, a headless box) must still get a working desk - the URL is printed either way.
export async function openBrowser(url: string): Promise<void> {
	const { command, args } = browserOpener(url)
	await execFileAsync(command, args).catch(() => undefined)
}

function browserOpener(url: string): { command: string; args: string[] } {
	if (process.platform === 'darwin') return { command: 'open', args: [url] }
	if (process.platform === 'win32')
		return { command: 'cmd', args: ['/c', 'start', '', url] }
	return { command: 'xdg-open', args: [url] }
}
