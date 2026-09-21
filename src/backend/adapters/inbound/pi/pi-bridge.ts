import { Type } from 'typebox'

import { PiDeskAttachment } from './pi-attachment.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const parameters = Type.Object({
	action: Type.Optional(
		Type.String({ enum: ['attach', 'detach', 'status'] }),
	),
	session: Type.Optional(Type.String({ minLength: 1 })),
	repo: Type.Optional(Type.String({ minLength: 1 })),
})

export function registerDeskBridge(pi: ExtensionAPI): void {
	const attachment = new PiDeskAttachment(pi)
	registerAttachmentTool(pi, attachment)
	pi.on('session_start', (_event, ctx) => attachment.restore(ctx))
	pi.on('session_shutdown', () => attachment.stop())
}

function registerAttachmentTool(
	pi: ExtensionAPI,
	attachment: PiDeskAttachment,
): void {
	pi.registerTool({
		name: 'syneva_agent',
		label: 'Syneva agent connection',
		description:
			'Attach this persistent Pi session to a running Syneva desk (action attach, explicit session, optional repo). The desk answers questions itself through one dedicated correspondent thread (a `pi -p` session file in the review dir), so this session is woken only for completed reviews, closed desks, and correspondent failures - each pointing at a saved JSON event. Use instead of syneva await or a one-shot waiting subagent. One desk per Pi session; detach before switching. status reports the connection. Detach only when the human ends the review; it does not stop the desk. Print/JSON children cannot attach. Received events are saved as JSON files and delivered as file references, never truncated. Transport failures require reattachment; reload/resume restores the same owner, never a fork.',
		promptGuidelines: [
			'After starting a Syneva desk, use syneva_agent to attach the owning persistent session before returning control to the human. Do not delegate waiting to a one-shot subagent.',
		],
		parameters,
		// registerTool's callback is positional, one parameter past the preset's cap; the signal and ctx
		// ride the tail of the rest list (signal, onUpdate, ctx) instead of a silent disable. The signal
		// is forwarded to detach: an interrupted tool call is a human asking the wait to stop, and the
		// teardown races the abort instead of ignoring it.
		async execute(_id, args, ...tail) {
			const [signal, , ctx] = tail
			const action = args.action ?? 'attach'
			if (action === 'detach') await attachment.detach(ctx, signal)
			else if (action === 'attach') {
				if (!args.session)
					throw new Error(
						'syneva_agent attach requires the desk session printed when starting Syneva.',
					)
				await attachment.attach(
					{ repo: args.repo ?? ctx.cwd, session: args.session },
					ctx,
				)
			}
			return {
				content: [{ type: 'text', text: attachment.describe() }],
				details: { connected: attachment.isConnected() },
			}
		},
	})
}
