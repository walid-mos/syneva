import type { AwaitEvent, QuestionPayload } from '../types.js'

export type EventStream = {
	emit(event: AwaitEvent): void
	// The next deliverable event, with queued questions drained into one batch when the head is a
	// question; undefined when nothing is queued.
	takeNext(): AwaitEvent | undefined
	// Park a waiter for the next event; returns the undo (also used when the long-poll gives up).
	park(waiter: (event: AwaitEvent) => void): () => void
	listenerCount(): number
	queuedCounts(): { questions: number; reviews: number }
}

// The desk's tagged event stream: `galley await` is a stream of "question" (reviewer clicked Ask,
// wants an answer now) and "review" (reviewer hit Send). An event hands straight to a parked waiter,
// else queues (FIFO) until one arms.
//
// Two invariant-preserving rules live here rather than in the routes:
//  - A Send flushes every still-queued question: the review supersedes them (their unanswered ones
//    ride out in result.openQuestions), so a stale question can never dribble in after the round
//    lands.
//  - Draining all queued questions into one event is safe BECAUSE of the flush above: a review can
//    never sit between two queued questions, so a batch can't skip past one.
export function createEventStream(): EventStream {
	const waiters: Array<(event: AwaitEvent) => void> = []
	const queue: AwaitEvent[] = []
	return {
		emit(event: AwaitEvent): void {
			if (event.kind === 'review') dropQueuedQuestions(queue)
			const waiter = waiters.shift()
			if (waiter) waiter(event)
			else queue.push(event)
		},
		takeNext(): AwaitEvent | undefined {
			if (!queue.length) return undefined
			const [head] = queue
			if (head.kind !== 'question') return queue.shift()
			return drainQuestions(queue)
		},
		park(waiter: (event: AwaitEvent) => void): () => void {
			waiters.push(waiter)
			return () => {
				const index = waiters.indexOf(waiter)
				if (index >= 0) waiters.splice(index, 1)
			}
		},
		listenerCount(): number {
			return waiters.length
		},
		queuedCounts(): { questions: number; reviews: number } {
			return {
				questions: queue.filter(event => event.kind === 'question')
					.length,
				reviews: queue.filter(event => event.kind === 'review').length,
			}
		},
	}
}

// All queued questions as one event, oldest first: singular `question` is the oldest (kept for
// compatibility), `questions` holds every question in arrival order.
function drainQuestions(queue: AwaitEvent[]): AwaitEvent {
	const batched: QuestionPayload[] = []
	for (let index = queue.length - 1; index >= 0; index--) {
		const event = queue[index]
		if (event.kind !== 'question') continue
		batched.unshift(...event.questions)
		queue.splice(index, 1)
	}
	return { kind: 'question', question: batched[0], questions: batched }
}

function dropQueuedQuestions(queue: AwaitEvent[]): void {
	for (let index = queue.length - 1; index >= 0; index--)
		if (queue[index].kind === 'question') queue.splice(index, 1)
}
