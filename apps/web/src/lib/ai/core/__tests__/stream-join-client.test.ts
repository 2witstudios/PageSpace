import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Stream-join must go through `fetchWithAuth`, not global fetch. On the desktop
// shell there is no session cookie — the Bearer is attached per API call — and
// the middleware 401s a cookie-less API request before the route ever runs
// (middleware.ts). Mocking the module rather than the global is what keeps that
// seam under test: a regression to plain `fetch` makes these mocks unused and
// the assertion below fails.
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

/** A text part arrives as three frames; the fold needs the start before any delta. */
const textFrames = (...deltas: string[]) => [
  'data: {"seq":0,"chunk":{"type":"text-start","id":"t1"}}\n\n',
  ...deltas.map((d, i) => `data: {"seq":${i + 1},"chunk":{"type":"text-delta","id":"t1","delta":"${d}"}}\n\n`),
];

/** The folded shape a completed text part reduces to. */
const textPart = (text: string) => ({
  type: 'text', text, state: 'streaming', providerMetadata: undefined,
});

describe('consumeStreamJoin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function encodeLines(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });
  }

  function stubFetch(body: ReadableStream<Uint8Array>, ok = true, status = 200) {
    mockFetchWithAuth.mockResolvedValue({ ok, status, body });
  }

  it('given frames and a done sentinel, should fold them and report the seq each fold reflects', async () => {
    stubFetch(encodeLines([
      ...textFrames('hello', ' world'),
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: { parts: unknown[]; seq: number }[] = [];
    const result = await consumeStreamJoin('m1', new AbortController().signal,
      (parts, seq) => seen.push({ parts, seq }));

    expect(result).toEqual({ aborted: false, resumeFromSeq: undefined, reload: false });
    // The caller gets the FULL folded array each time, not a delta — so it writes with
    // replace semantics and there is no skip count to get wrong.
    expect(seen.at(-1)).toEqual({ parts: [textPart('hello world')], seq: 2 });
  });

  it('given a tool round trip, should fold it into one part rather than forwarding raw frames', async () => {
    stubFetch(encodeLines([
      'data: {"seq":0,"chunk":{"type":"tool-input-start","toolCallId":"tc1","toolName":"list_pages"}}\n\n',
      'data: {"seq":1,"chunk":{"type":"tool-input-available","toolCallId":"tc1","toolName":"list_pages","input":{"driveId":"d1"}}}\n\n',
      'data: {"seq":2,"chunk":{"type":"tool-output-available","toolCallId":"tc1","output":{"pages":[]}}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: unknown[][] = [];
    await consumeStreamJoin('m1', new AbortController().signal, (parts) => seen.push(parts));

    expect(seen.at(-1)).toHaveLength(1);
    expect(seen.at(-1)?.[0]).toMatchObject({
      type: 'tool-list_pages', toolCallId: 'tc1', state: 'output-available',
    });
  });

  it('given reasoning frames, should fold them — the wire this replaces dropped them entirely', async () => {
    // chunkToPart forwarded four chunk types, so a joiner never saw reasoning, files or
    // sources. That is the fidelity gap this whole change exists to close.
    stubFetch(encodeLines([
      'data: {"seq":0,"chunk":{"type":"reasoning-start","id":"r1"}}\n\n',
      'data: {"seq":1,"chunk":{"type":"reasoning-delta","id":"r1","delta":"thinking"}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: unknown[][] = [];
    await consumeStreamJoin('m1', new AbortController().signal, (parts) => seen.push(parts));

    expect(seen.at(-1)?.[0]).toMatchObject({ type: 'reasoning', text: 'thinking' });
  });

  it('given done sentinel with aborted: true, should return { aborted: true } without throwing', async () => {
    stubFetch(encodeLines(['data: {"done":true,"aborted":true}\n\n']));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const result = await consumeStreamJoin('m1', new AbortController().signal, () => {});

    expect(result.aborted).toBe(true);
  });

  it('given the server refuses the cursor as too old, should surface the resume point', async () => {
    // The successor to silently serving a later prefix. An evicted cursor is recoverable if
    // the client is told where to restart, and a silent gap is not.
    stubFetch(encodeLines(['data: {"done":true,"resumeFromSeq":42}\n\n']));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const result = await consumeStreamJoin('m1', new AbortController().signal, () => {}, 7);

    expect(result.resumeFromSeq).toBe(42);
  });

  it('given malformed SSE lines, should skip them and continue processing', async () => {
    stubFetch(encodeLines([
      'data: {not json}\n\n',
      ...textFrames('ok'),
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: unknown[][] = [];
    await consumeStreamJoin('m1', new AbortController().signal, (parts) => seen.push(parts));

    expect(seen.at(-1)).toEqual([textPart('ok')]);
  });

  it('given a frame with no chunk type or no seq, should skip it rather than feed the fold garbage', async () => {
    stubFetch(encodeLines([
      'data: {"seq":0,"chunk":{}}\n\n',
      'data: {"chunk":{"type":"text-start","id":"t1"}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: unknown[][] = [];
    await consumeStreamJoin('m1', new AbortController().signal, (parts) => seen.push(parts));

    expect(seen).toEqual([]);
  });

  it('given a legacy {part:...} frame from an old server, should skip it', async () => {
    // Mid-rollout an old worker still emits the previous wire. Skipping is correct: the fold
    // consumes chunks, and a part fed to it would produce nothing coherent.
    stubFetch(encodeLines([
      'data: {"part":{"type":"text","text":"legacy"}}\n\n',
      'data: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: unknown[][] = [];
    await consumeStreamJoin('m1', new AbortController().signal, (parts) => seen.push(parts));

    expect(seen).toEqual([]);
  });

  it('given a cursor, should request it through the authenticated transport', async () => {
    stubFetch(encodeLines(['data: {"done":true,"aborted":false}\n\n']));

    const { consumeStreamJoin } = await import('../stream-join-client');
    await consumeStreamJoin('m1', new AbortController().signal, () => {}, 12);

    // Credentials are `fetchWithAuth`'s business now — it attaches the desktop
    // Bearer and the web cookie. Asserting `credentials: 'include'` here would
    // be re-asserting the transport's contract, and would have kept passing
    // against the plain-fetch bug this file now guards.
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/ai/chat/stream-join/m1?fromSeq=12',
      expect.anything(),
    );
  });

  it('given messageId with special characters, should URL-encode it in the request', async () => {
    stubFetch(encodeLines(['data: {"done":true,"aborted":false}\n\n']));

    const { consumeStreamJoin } = await import('../stream-join-client');
    await consumeStreamJoin('m 1/x', new AbortController().signal, () => {});

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/ai/chat/stream-join/m%201%2Fx?fromSeq=0',
      expect.anything(),
    );
  });

  it('given an SSE line split across two read chunks, should buffer and parse correctly', async () => {
    stubFetch(encodeLines([
      'data: {"seq":0,"chunk":{"type":"text-start","id":"t1"}}\n\ndata: {"seq":1,"chunk":{"type":"text-de',
      'lta","id":"t1","delta":"split"}}\n\ndata: {"done":true,"aborted":false}\n\n',
    ]));

    const { consumeStreamJoin } = await import('../stream-join-client');
    const seen: unknown[][] = [];
    await consumeStreamJoin('m1', new AbortController().signal, (parts) => seen.push(parts));

    expect(seen.at(-1)).toEqual([textPart('split')]);
  });

  it('given the desktop shell, should join through fetchWithAuth so a Bearer is attached', async () => {
    // The regression this guards: `consumeStreamJoin` used plain `fetch` with
    // `credentials: 'include'`. On desktop there is no session cookie, so the
    // middleware 401s the request before the route runs and the user watches a
    // stream they can never join. Every other authenticated call in the app
    // goes through `fetchWithAuth`, which attaches the Bearer and refreshes on
    // 401; this one silently did not.
    stubFetch(encodeLines(['data: {"done":true,"aborted":false}\n\n']));
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    const { consumeStreamJoin } = await import('../stream-join-client');
    await consumeStreamJoin('m1', new AbortController().signal, () => {});

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth.mock.calls[0][0]).toContain('/api/ai/chat/stream-join/m1');
    // Plain fetch must not be the transport, or desktop loses its Bearer.
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
