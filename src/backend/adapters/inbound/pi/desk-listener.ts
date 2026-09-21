// A received event envelope, as receiveDeskEvent hands it over: the saved JSON
// file's path (what the agent got pointed at) plus its kind, so the listener can
// recognize the terminal `closed` event without reading the file back.
export type DeskEventEnvelope = { eventPath: string; kind: string }

type DeskListener = {
	signal: AbortSignal
	receive: (signal: AbortSignal) => Promise<string | DeskEventEnvelope>
	deliver: (event: string | DeskEventEnvelope) => void
}

// The attachment, not an LLM turn or a one-shot child, owns this loop. Empty 204s
// rearm it; a `closed` event ends it (the human ended the review in the browser);
// an abort before delivery, or a reported transport failure, stops otherwise.
export async function startDeskListener(listener: DeskListener): Promise<void> {
	try {
		// The abort re-check comes BEFORE the cycle so an abort during delivery never reruns
		// receive: a replaced attachment's loop must not read another event.
		while (!listener.signal.aborted && (await listenOnce(listener)));
	} catch (error) {
		if (!listener.signal.aborted) throw error
	}
}

// One receive→deliver cycle. True to keep listening: a timeout (no event) rearms,
// a normal event delivers. False to stop: an abort before delivery, or `closed`.
async function listenOnce(listener: DeskListener): Promise<boolean> {
	const event = await listener.receive(listener.signal)
	if (listener.signal.aborted) return false
	if (!event) return true
	listener.deliver(event)
	return !isClosed(event)
}

function isClosed(event: string | DeskEventEnvelope): boolean {
	return typeof event === 'object' && event.kind === 'closed'
}
