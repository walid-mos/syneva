// Per-worker message router for the token pool: classifies a worker reply once (control round
// trips carry their requestType; window replies go to the manager's collect path; failures flow
// to one error handler), so the manager owns a single routing table instead of bespoke glue per
// message kind.
import type { WorkerResponse } from '@shared/diff-renderer/token-pool/protocol'
import type { WorkerTokenWindowSuccess } from '@shared/diff-renderer/token-pool/protocol'
import type { WorkerFailure } from '@shared/diff-renderer/token-pool/protocol'

export type WorkerRouterHandlers = {
	// initialize / set-render-options / open-diff acknowledgements.
	onControl: (worker: Worker, id: string, response: WorkerResponse) => void
	// A finished token-window task.
	onWindowSuccess: (
		worker: Worker,
		response: WorkerTokenWindowSuccess,
	) => void
	// A failed token-window task (the recipient resolves its task id).
	onWindowFailure: (
		worker: Worker,
		id: string,
		failure: WorkerFailure,
	) => void
	// A dead worker (its in-flight tasks resolve nowhere; plain rows stay).
	onWorkerError: (error: ErrorEvent) => void
}

export function listenToWorker(
	worker: Worker,
	handlers: WorkerRouterHandlers,
): void {
	worker.addEventListener(
		'message',
		(event: MessageEvent<WorkerResponse>) => {
			const response = event.data
			if (response.type === 'error') {
				// Failures ride their own path (the recipient looks the task up by id).
				handlers.onWindowFailure(worker, response.id, response)
				return
			}
			if (response.requestType === 'token-window') {
				handlers.onWindowSuccess(worker, response)
				return
			}
			handlers.onControl(worker, response.id, response)
		},
	)
	// A dead worker leaves its tasks unresolved; the manager logs the error event on its own
	// - every window keeps its plain rows in the skeleton, so the desk degrades to uncolored
	// rows, not broken ones.
	worker.addEventListener('error', error => {
		handlers.onWorkerError(error)
	})
}
