type DeskListener = {
	signal: AbortSignal
	receive: (signal: AbortSignal) => Promise<string>
	deliver: (event: string) => void
}

// The attachment, not an LLM turn or a one-shot child, owns this loop. Empty 204s
// rearm it; only explicit detach/shutdown or a reported transport failure stops it.
export async function startDeskListener(listener: DeskListener): Promise<void> {
	try {
		while (!listener.signal.aborted) await deliverNext(listener)
	} catch (error) {
		if (!listener.signal.aborted) throw error
	}
}

async function deliverNext({
	signal,
	receive,
	deliver,
}: DeskListener): Promise<void> {
	const event = await receive(signal)
	if (!signal.aborted && event) deliver(event)
}
