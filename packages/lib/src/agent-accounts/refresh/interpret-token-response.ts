/**
 * `interpretTokenResponse` — what the pinned HTTPS client's outcome for a
 * refresh means (RFC 6749 §5.1 success is exactly 200; §5.2 error body;
 * RFC 9110 §10.2.3 Retry-After). Pure; the refresh worker feeds a failure to
 * `classifyRefreshFailure` and a body to `planRefreshedMaterial`.
 *
 * - Success is a complete 200 whose body is a JSON object. A truncated or
 *   unparseable 200 is `malformed_response`: the provider may already have
 *   rotated the refresh token, so it must not be treated as retryable.
 * - An error status carries the body's string `error` code (or null) and a
 *   Retry-After given as delta-seconds or an HTTP date, converted to ms from
 *   `now`; a past, negative or unreadable one is dropped.
 * - A transport failure is `timeout` or `network`, whichever phase it was in:
 *   the classifier treats both as retryable.
 */
import type { SendOutcome } from '../executor/pinned-https-client';
import type { RefreshFailure } from './classify-refresh-failure';

export type TokenResponseReading = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly failure: RefreshFailure };

const parseJson = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const retryAfterMs = (headers: readonly (readonly [string, string])[], now: number): number | null => {
  const raw = headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1].trim();
  if (raw === undefined) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > now ? at - now : null;
};

export function interpretTokenResponse({ send, now }: { readonly send: SendOutcome; readonly now: number }): TokenResponseReading {
  if (send.kind === 'refused') return { ok: false, failure: { kind: 'network' } };
  if (send.kind === 'failed') return { ok: false, failure: { kind: send.reason === 'timeout' ? 'timeout' : 'network' } };
  if (send.status === 200) {
    const body = send.truncated ? undefined : parseJson(send.body);
    return isRecord(body) ? { ok: true, body } : { ok: false, failure: { kind: 'malformed_response' } };
  }
  const errorBody = parseJson(send.body);
  const oauthError = isRecord(errorBody) && typeof errorBody.error === 'string' ? errorBody.error : null;
  return { ok: false, failure: { kind: 'status', status: send.status, oauthError, retryAfterMs: retryAfterMs(send.headers, now) } };
}
