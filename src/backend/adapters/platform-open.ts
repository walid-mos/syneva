// The one per-platform command that opens a URL or file with the OS default handler. The desk's
// browser tab (inbound/http) and the empty-template editor fallback (outbound/editor) share it, so
// a platform rule change (a new opener, a Windows quirk) lands on both callers at once.
export function platformOpenCommand(target: string): {
	command: string
	args: string[]
} {
	if (process.platform === 'darwin')
		return { command: 'open', args: [target] }
	if (process.platform === 'win32')
		return { command: 'cmd', args: ['/c', 'start', '', target] }
	return { command: 'xdg-open', args: [target] }
}
