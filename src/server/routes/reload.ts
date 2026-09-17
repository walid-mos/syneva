import { HTTP_OK, HTTP_UNPROCESSABLE, readBody, json, fail } from '../http.js'
import { reloadDesk } from '../reload-desk.js'

import type { ApiFailure } from '../failure.js'
import type { RouteRequest } from '../router.js'

export async function reloadDeskFromRequest({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		const outcome = await reloadDesk(
			ctx.state,
			(): Promise<string> => ctx.persist(),
			await readBody(req),
		)
		if (outcome.kind === 'invalid-guide')
			return fail(res, invalidGuide(outcome.reason))
		json(res, HTTP_OK, {
			ok: true,
			empty: outcome.kind === 'empty',
			baseDiffHash: outcome.baseDiffHash,
		})
	})
}

function invalidGuide(reason: string): ApiFailure {
	return {
		status: HTTP_UNPROCESSABLE,
		code: 'INVALID_GUIDE',
		error: `Invalid guide: ${reason}.`,
		fix: 'Run `syneva spec` for the guided-review schema.',
	}
}
