import { sendReview } from '@entities/review/api'
import { reviewerSlice } from '@entities/review/save'
import { featureCtx } from '@features/context'

// The one-way handoff: post only the reviewer-owned slice, never the whole (multi-MB)
// ReviewState. Big desks used to cross the server's body cap on Send and 500 ("Could not
// send review") while the slice-only auto-saves kept succeeding; the server merges this
// slice and builds the result from its own authoritative state. overallNote is a one-time
// instruction for the whole review; the server reads it off the body and never persists it
// (see /api/send in the HTTP adapter).
export async function sendReviewToAgent(overallNote = ''): Promise<void> {
	const { sent } = await sendReview({
		...reviewerSlice(featureCtx().requireState()),
		overallNote,
	})
	if (sent) {
		featureCtx().S.awaitingAgent = true
		featureCtx().toast('Sent to agent')
		return
	}
	featureCtx().toast('Could not send review')
}
