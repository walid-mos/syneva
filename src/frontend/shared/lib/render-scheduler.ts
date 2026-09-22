// The narrow render seam the layering contract earns: every layer below pages (features,
// entities, widgets' lower modules) may request a render, but none of them may import the
// funnel itself (pages/desk/render.ts) - composition happens above. app/main imports the
// funnel, whose module body registers it here; until then the desk is pre-init and a
// request is a bug, so it fails loudly.
type RenderFunnel = {
	render: () => Promise<void>
	deferRender: (isForcedIfBig?: boolean) => void
}

let funnel: RenderFunnel | null = null

export function registerRenderFunnel(registered: RenderFunnel): void {
	funnel = registered
}

function needFunnel(): RenderFunnel {
	if (!funnel)
		throw new Error('render requested before the funnel registered')
	return funnel
}

export function render(): Promise<void> {
	return needFunnel().render()
}

export function deferRender(isForcedIfBig = false): void {
	needFunnel().deferRender(isForcedIfBig)
}
