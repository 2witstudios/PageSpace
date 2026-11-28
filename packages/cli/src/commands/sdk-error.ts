/**
 * Shared "call the SDK, surface the server's own error honestly" wrapper
 * every drives/pages/trash verb uses (Phase 5 task 1) — one place that
 * decides exit code 1 vs. rethrow, so no command hand-rolls its own
 * try/catch/format triple.
 */
import type { HandlerContext } from '../handler-context.js';
import { formatCliError } from '../format-error.js';

export type SdkCallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** `ctx` carries where to print and which class of credential was used, so a sign-in denial names the right fix. */
export async function callSdk<T>(ctx: Pick<HandlerContext, 'stderr' | 'credentialKind'>, fn: () => Promise<T>): Promise<SdkCallResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    ctx.stderr.write(`${formatCliError(error, ctx.credentialKind)}\n`);
    return { ok: false };
  }
}
