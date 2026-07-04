/**
 * Shared "call the SDK, surface the server's own error honestly" wrapper
 * every drives/pages/trash verb uses (Phase 5 task 1) — one place that
 * decides exit code 1 vs. rethrow, so no command hand-rolls its own
 * try/catch/format triple.
 */
import type { OutputSink } from '../handler-context.js';

export type SdkCallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export async function callSdk<T>(stderr: OutputSink, fn: () => Promise<T>): Promise<SdkCallResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false };
  }
}
