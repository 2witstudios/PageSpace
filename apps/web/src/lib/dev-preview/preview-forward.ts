/**
 * The HTTP half of the preview proxy — ONE request, forwarded and streamed.
 *
 * The caller has already run the gate (`resolvePreviewTarget`) and hands over
 * the sprite URL it got from the control plane; this module never sees a
 * client-supplied host. What it does: builds the upstream URL from that
 * origin plus the request's raw path and query; forwards only the
 * allowlisted request headers plus the org token; streams the request body
 * up (bounded) and the response body down (bounded, idle-cut); relays only
 * the allowlisted response headers, sanitizes `Set-Cookie`, rewrites a
 * sprite-origin `Location`, and appends PageSpace's own framing/caching
 * headers. Every bound and every header rule is the pure policy's
 * (`preview-proxy-policy.ts`); this file is the plumbing.
 *
 * `fetch`, not `https.request`, because a Next route handler speaks Web
 * streams natively. Two consequences the policy already accounts for:
 * `Accept-Encoding` is not forwarded (so upstream sends identity and the
 * decoded body matches its headers), and `redirect: 'manual'` keeps a dev
 * server's redirects on the preview host instead of following them into the
 * sprite.
 */

import {
  PREVIEW_PROXY_LIMITS,
  buildPreviewResponseHeaders,
  buildPreviewUpstreamUrl,
  rewriteUpstreamLocation,
  selectForwardableRequestHeaders,
  selectForwardableResponseHeaders,
  type HeaderMap,
} from '@pagespace/lib/services/sandbox/preview/preview-proxy-policy';
import { sanitizeUpstreamSetCookie } from '@pagespace/lib/services/sandbox/preview/preview-grant';

export interface ForwardPreviewRequestInput {
  request: Request;
  /** The request's path AND query below the preview origin (raw, still encoded). */
  pathAndQuery: string;
  spriteUrl: string;
  token: string;
  appOrigin: string | null;
  fetchImpl?: typeof fetch;
  limits?: typeof PREVIEW_PROXY_LIMITS;
}

export type ForwardPreviewOutcome =
  | { kind: 'response'; response: Response; upstreamStatus: number }
  | { kind: 'refused'; status: 413; reason: 'request-too-large' }
  | { kind: 'upstream-error'; status: 502 | 504; reason: string };

function flatten(headers: Headers): HeaderMap {
  const out: HeaderMap = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    out[name.toLowerCase()] = value;
  });
  return out;
}

/** A pass-through that fails the stream once more than `maxBytes` have flowed, and resets `onChunk` for the idle timer. */
function boundedStream(maxBytes: number, onChunk: () => void, onLimit: () => void): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        onLimit();
        controller.error(new Error('preview proxy byte limit exceeded'));
        return;
      }
      onChunk();
      controller.enqueue(chunk);
    },
  });
}

export async function forwardPreviewRequest({
  request,
  pathAndQuery,
  spriteUrl,
  token,
  appOrigin,
  fetchImpl = fetch,
  limits = PREVIEW_PROXY_LIMITS,
}: ForwardPreviewRequestInput): Promise<ForwardPreviewOutcome> {
  const upstream = buildPreviewUpstreamUrl(spriteUrl, pathAndQuery);

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxRequestBodyBytes) {
    return { kind: 'refused', status: 413, reason: 'request-too-large' };
  }

  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let limitHit = false;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('preview proxy idle timeout')), limits.streamIdleTimeoutMs);
  };
  const headersTimer = setTimeout(() => controller.abort(new Error('preview proxy headers timeout')), limits.upstreamHeadersTimeoutMs);

  const headers = new Headers(selectForwardableRequestHeaders(flatten(request.headers)));
  headers.set('authorization', `Bearer ${token}`);
  // Pinned, not merely omitted: undici adds `gzip, deflate` on its own and
  // decodes transparently, so the only way the relayed body and the relayed
  // headers describe the same bytes is to ask upstream for identity.
  headers.set('accept-encoding', 'identity');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
  const body = hasBody
    ? request.body!.pipeThrough(boundedStream(limits.maxRequestBodyBytes, touch, () => { limitHit = true; controller.abort(new Error('request body limit')); }))
    : undefined;

  let response: Response;
  try {
    response = await fetchImpl(upstream, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
      // Required by undici for a streaming request body; not in the lib.dom type yet.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (error) {
    clearTimeout(headersTimer);
    if (limitHit) return { kind: 'refused', status: 413, reason: 'request-too-large' };
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'upstream-error', status: controller.signal.aborted ? 504 : 502, reason };
  }
  clearTimeout(headersTimer);
  touch();

  const relayed = new Headers(selectForwardableResponseHeaders(flatten(response.headers)));
  const location = relayed.get('location');
  if (location !== null) relayed.set('location', rewriteUpstreamLocation(location, upstream.origin));
  for (const raw of response.headers.getSetCookie()) {
    const safe = sanitizeUpstreamSetCookie(raw);
    if (safe !== null) relayed.append('set-cookie', safe);
  }
  for (const [name, value] of buildPreviewResponseHeaders(appOrigin)) {
    if (name === 'content-security-policy') relayed.append(name, value);
    else relayed.set(name, value);
  }

  const upstreamBody = response.body;
  const streamed = upstreamBody === null || request.method === 'HEAD'
    ? null
    : upstreamBody.pipeThrough(boundedStream(limits.maxResponseBodyBytes, touch, () => controller.abort(new Error('response body limit'))));

  // The idle timer dies with the stream. On a client cancel it fires once
  // more against an already-aborted fetch, which is a harmless no-op
  // (`Transformer.cancel` is not in the TS lib yet).
  const finish = () => { if (idleTimer) clearTimeout(idleTimer); };
  const bodyWithCleanup = streamed === null
    ? null
    : streamed.pipeThrough(new TransformStream({ flush: finish }));
  if (bodyWithCleanup === null) finish();

  return {
    kind: 'response',
    response: new Response(bodyWithCleanup, { status: response.status, statusText: response.statusText, headers: relayed }),
    upstreamStatus: response.status,
  };
}
