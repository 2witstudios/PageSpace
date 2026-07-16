import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { SeededUser } from './db';

const MOCK_BASE = process.env.E2E_MOCK_OPENROUTER_URL ?? 'http://127.0.0.1:4998';

/**
 * POST as a session-authenticated user: sends the opaque session cookie plus the
 * matching X-CSRF-Token header. No Origin header — `validateOrigin` allows a missing
 * Origin (same-origin / non-browser clients), so this satisfies the CSRF gate.
 */
export function sessionPost(
  request: APIRequestContext,
  path: string,
  user: SeededUser,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<APIResponse> {
  return request.post(path, {
    headers: {
      cookie: `session=${user.sessionToken}`,
      'x-csrf-token': user.csrf,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * POST with an MCP bearer token. Bearer auth is exempt from CSRF/origin checks, so this
 * is the clean way to drive routes that accept `allow: ['session', 'mcp']`.
 */
export function mcpPost(
  request: APIRequestContext,
  path: string,
  mcpToken: string,
  body?: unknown,
): Promise<APIResponse> {
  return request.post(path, {
    headers: {
      authorization: `Bearer ${mcpToken}`,
      'content-type': 'application/json',
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Reset the mock OpenRouter call recorder. */
export async function resetMock(request: APIRequestContext): Promise<void> {
  await request.post(`${MOCK_BASE}/__reset`);
}

/** How many chat-completions hits the mock has seen since the last reset. */
export async function mockCallCount(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${MOCK_BASE}/__calls`);
  const json = (await res.json()) as { count: number };
  return json.count;
}

/**
 * Choose how the mock paces its next streams, and optionally the slow-mode pacing
 * (`chunks` × `intervalMs` is the live window a spec gets to assert against).
 *
 * `mode` is the ONLY pacing control that works for a send driven through the UI: the app
 * rewrites unknown model ids to its DEFAULT_MODEL before calling the provider, so seeding a
 * user with `e2e/slow-stream` does NOT reach the mock. Reset to `instant` by `resetMock`.
 */
export async function setStreamConfig(
  request: APIRequestContext,
  config: { chunks?: number; intervalMs?: number; mode?: 'instant' | 'slow' | 'held' },
): Promise<void> {
  await request.post(`${MOCK_BASE}/__stream-config`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify(config),
  });
}

/**
 * How many mock streams are open right now, how many are held awaiting release, and the
 * pacing mode in force.
 *
 * `mode` is surfaced deliberately: from `open: 0` alone a spec cannot tell "the stream already
 * finished" from "the mode never took effect", and those have opposite fixes. Assert on it
 * when a poll for `open`/`held` times out unexpectedly.
 */
export async function mockStreams(
  request: APIRequestContext,
): Promise<{ open: number; held: number; mode: 'instant' | 'slow' | 'held' }> {
  const res = await request.get(`${MOCK_BASE}/__streams`);
  return (await res.json()) as { open: number; held: number; mode: 'instant' | 'slow' | 'held' };
}

/**
 * End the deterministic live window: flush + terminate every held stream. Pair with
 * `expect.poll(() => mockStreams(request))` to know the stream was live first.
 */
export async function releaseStreams(request: APIRequestContext): Promise<void> {
  await request.post(`${MOCK_BASE}/__release-stream`);
}

/**
 * Override the authoritative `/generation` cost the reconcile cron will read. With `id`
 * set, only that generation's cost changes; without it, the default for all unknown ids.
 * `totalCost` is in US dollars (OpenRouter's `data.total_cost` shape).
 */
export async function setGenerationCost(
  request: APIRequestContext,
  totalCost: number,
  id?: string,
): Promise<void> {
  await request.post(`${MOCK_BASE}/__set-generation-cost`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ totalCost, id }),
  });
}
