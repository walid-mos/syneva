import { S, esc } from './store'

// The waiting indicator under an unanswered question has three states, derived per poll tick from
// the desk-liveness fields: queued (the question never reached an agent - nothing is awaiting),
// active (delivered, and the agent posted a `syneva status` line), or plain waiting. Desk-global
// by design: one desk, one agent.
function awaitingParts(): {
	isQueued: boolean
	label: string
	activity: string
} {
	const isQueued = S.queuedQuestions > 0
	return {
		isQueued,
		label: isQueued ? 'No agent attached - question queued' : 'Working',
		activity: isQueued ? '' : (S.agentActivity ?? ''),
	}
}

// The indicator's markup, for the paths that build a thread from an HTML string.
export function awaitingHtml(): string {
	const { isQueued, label, activity } = awaitingParts()
	const queued = isQueued ? ' queued' : ''
	const activityHtml = activity ? esc(` · ${activity}`) : ''
	return `<div class="awaiting-answer${queued}"><span class="awaiting-label">${esc(label)}</span><span class="agent-activity">${activityHtml}</span></div>`
}

// Patch every mounted waiting indicator in place. Called from the 1.5s poll: activity/presence
// changes alone must not trigger a full render() (it rebuilds the diff DOM), so the indicator
// spans are updated directly.
export function updateAwaitingDom(): void {
	const parts = awaitingParts()
	for (const el of document.querySelectorAll('.awaiting-answer')) {
		el.classList.toggle('queued', parts.isQueued)
		const label = el.querySelector('.awaiting-label')
		if (label && label.textContent !== parts.label)
			label.textContent = parts.label
		const activity = el.querySelector('.agent-activity')
		const text = parts.activity ? ` · ${parts.activity}` : ''
		if (activity && activity.textContent !== text)
			activity.textContent = text
	}
}
