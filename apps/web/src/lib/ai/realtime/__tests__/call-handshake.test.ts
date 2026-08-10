/**
 * Handshake tests. Every network hop is an injected `fetch`, so nothing here
 * reaches OpenAI or the realtime server.
 *
 * The cases that carry the most weight are the ones about a credential:
 * the ephemeral secret must authenticate the CALL creation (not the API key),
 * it must reach the realtime server, and it must never appear in what we hand
 * back to the browser.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  parseCallId,
  runCallHandshake,
  type HandshakeDeps,
  type HandshakeLogger,
} from '../call-handshake';
import { CLIENT_SECRETS_URL, REALTIME_CALLS_URL } from '../session';
import { VOICE_BRIDGE_ROUTES } from '@pagespace/lib/realtime/voice-bridge-contract';

const SECRET = 'ek_call_secret';
const CALL_ID = 'rtc_u0_EBNOwQshLeDzYP6HmPHHV';
const ANSWER_SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n';
const OFFER_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';

const TOOLS = [
  { type: 'function' as const, name: 'read_page', description: 'Read a page.', parameters: {} },
];

type FetchCall = { url: string; init: RequestInit };

/** A response the handshake code can read like a real one. */
function response(
  init: {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  const headers = new Headers(init.headers ?? {});
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers,
    json: async () => init.json,
    text: async () => init.text ?? (init.json === undefined ? '' : JSON.stringify(init.json)),
  } as unknown as Response;
}

const okMint = () => response({ json: { value: SECRET, expires_at: 1 } });
const okCall = () =>
  response({
    status: 201,
    text: ANSWER_SDP,
    headers: { Location: `/v1/realtime/calls/${CALL_ID}` },
  });
const okHandoff = () => response({ json: { success: true } });

function silentLogger(): HandshakeLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

/**
 * Build deps whose fetch answers by hop: mint, then call, then handoff. Any
 * hop can be overridden to fail.
 */
function harness(
  overrides: {
    mint?: () => Response;
    call?: () => Response;
    handoff?: () => Response | Promise<never>;
    internalRealtimeUrl?: string | undefined;
    model?: string;
    tools?: HandshakeDeps['tools'];
  } = {},
) {
  const calls: FetchCall[] = [];
  const logger = silentLogger();

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === CLIENT_SECRETS_URL) return (overrides.mint ?? okMint)();
    if (url === REALTIME_CALLS_URL) return (overrides.call ?? okCall)();
    return (overrides.handoff ?? okHandoff)();
  });

  const deps: HandshakeDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    apiKey: 'sk-managed-key',
    model: overrides.model ?? 'gpt-realtime-2.1',
    tools: overrides.tools ?? TOOLS,
    internalRealtimeUrl:
      'internalRealtimeUrl' in overrides ? overrides.internalRealtimeUrl : 'http://realtime:4000',
    signHeaders: vi.fn((body: string) => ({
      'Content-Type': 'application/json',
      'X-Broadcast-Signature': `t=1,v1=sig-over-${body.length}`,
    })),
    logger,
  };

  return { deps, calls, logger, fetchMock };
}

const run = (deps: HandshakeDeps, conversationId?: string) =>
  runCallHandshake(deps, {
    offerSdp: OFFER_SDP,
    userId: 'u1',
    ...(conversationId === undefined ? {} : { conversationId }),
  });

const byUrl = (calls: FetchCall[], url: string) => calls.find((c) => c.url === url);

describe('parseCallId', () => {
  it('given the relative Location OpenAI sends, should take the last segment', () => {
    expect(parseCallId(`/v1/realtime/calls/${CALL_ID}`)).toBe(CALL_ID);
  });

  it('given an absolute URL, should still take the last segment', () => {
    expect(parseCallId(`https://api.openai.com/v1/realtime/calls/${CALL_ID}`)).toBe(CALL_ID);
  });

  it('given a trailing slash or query, should ignore them', () => {
    expect(parseCallId(`/v1/realtime/calls/${CALL_ID}/`)).toBe(CALL_ID);
    expect(parseCallId(`/v1/realtime/calls/${CALL_ID}?x=1`)).toBe(CALL_ID);
  });

  it('given anything that is not an rtc_ id, should refuse rather than guess', () => {
    expect(parseCallId(null)).toBeUndefined();
    expect(parseCallId('')).toBeUndefined();
    expect(parseCallId('/v1/realtime/calls/')).toBeUndefined();
    // A session id is the id closest to hand at mint time, and it is wrong.
    expect(parseCallId('/v1/realtime/calls/sess_u0_abc')).toBeUndefined();
  });
});

describe('runCallHandshake — the happy path', () => {
  it('should return the answer SDP and the call id', async () => {
    const { deps } = harness();
    const result = await run(deps);

    expect(result).toEqual({
      ok: true,
      callId: CALL_ID,
      answerSdp: ANSWER_SDP,
      attached: true,
    });
  });

  it('should mint with the model it was GIVEN, never a built-in default', async () => {
    const { deps, calls } = harness({ model: 'gpt-realtime-from-env' });
    await run(deps);

    const mint = byUrl(calls, CLIENT_SECRETS_URL)!;
    const body = JSON.parse(String(mint.init.body));
    expect(body.session.model).toBe('gpt-realtime-from-env');
  });

  it('should mint with the API key and create the call with the EPHEMERAL secret', async () => {
    const { deps, calls } = harness();
    await run(deps);

    const mint = byUrl(calls, CLIENT_SECRETS_URL)!;
    const call = byUrl(calls, REALTIME_CALLS_URL)!;

    expect((mint.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-managed-key');
    // The API key cannot create the call; only the freshly minted secret can.
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('should post the raw SDP offer as application/sdp', async () => {
    const { deps, calls } = harness();
    await run(deps);

    const call = byUrl(calls, REALTIME_CALLS_URL)!;
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/sdp');
    expect(call.init.body).toBe(OFFER_SDP);
  });

  it('should NOT mint the tools in — they belong to the socket that executes them', async () => {
    const { deps, calls } = harness();
    await run(deps);

    const body = JSON.parse(String(byUrl(calls, CLIENT_SECRETS_URL)!.init.body));
    // Advertising tools on a call that may never get a server attached would
    // let the model call tools with nobody listening.
    expect(body.session.tools).toEqual([]);
  });
});

describe('runCallHandshake — the handoff to the realtime server', () => {
  it('should post the call, the secret and the tools to the attach route, signed', async () => {
    const { deps, calls } = harness();
    await run(deps, 'conv1');

    const handoff = byUrl(calls, `http://realtime:4000${VOICE_BRIDGE_ROUTES.attach}`)!;
    expect(handoff).toBeDefined();

    const body = JSON.parse(String(handoff.init.body));
    expect(body).toEqual({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      conversationId: 'conv1',
      tools: TOOLS,
    });

    // Signed over the EXACT body posted — the HMAC is computed on those bytes.
    expect(deps.signHeaders).toHaveBeenCalledWith(String(handoff.init.body));
    expect((handoff.init.headers as Record<string, string>)['X-Broadcast-Signature']).toContain('v1=');
  });

  it('given no conversationId, should omit the key rather than send undefined', async () => {
    const { deps, calls } = harness();
    await run(deps);

    const handoff = byUrl(calls, `http://realtime:4000${VOICE_BRIDGE_ROUTES.attach}`)!;
    expect(JSON.parse(String(handoff.init.body))).not.toHaveProperty('conversationId');
  });

  it('given INTERNAL_REALTIME_URL is unset, should still return the answer SDP and log why', async () => {
    const { deps, calls, logger } = harness({ internalRealtimeUrl: undefined });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: true, answerSdp: ANSWER_SDP, attached: false });
    // Two hops only: no handoff was attempted.
    expect(calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('INTERNAL_REALTIME_URL'),
      expect.objectContaining({ callId: CALL_ID }),
    );
  });

  it('given the realtime server answers non-200, should degrade to attached:false, not fail the call', async () => {
    const { deps, logger } = harness({
      handoff: () => response({ ok: false, status: 503, json: { error: 'down' } }),
    });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: true, answerSdp: ANSWER_SDP, attached: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('given the handoff throws, should degrade rather than lose a working call', async () => {
    const { deps, logger } = harness({
      handoff: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: true, attached: false });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('runCallHandshake — named failures', () => {
  it('given the mint fails, should report mint_failed with the upstream body', async () => {
    const { deps, calls } = harness({
      mint: () => response({ ok: false, status: 401, json: { error: { message: 'bad key' } } }),
    });
    const result = await run(deps);

    expect(result).toMatchObject({
      ok: false,
      code: 'mint_failed',
      upstreamStatus: 401,
      upstream: { error: { message: 'bad key' } },
    });
    // Nothing downstream ran.
    expect(calls).toHaveLength(1);
  });

  it('given the mint returns no secret, should report mint_missing_secret', async () => {
    const { deps } = harness({ mint: () => response({ json: { expires_at: 1 } }) });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: false, code: 'mint_missing_secret' });
  });

  it('given OpenAI 403s model_not_found at /v1/realtime/calls, should surface the upstream body verbatim', async () => {
    // The load-bearing case: the mint 200s for a model the project cannot use,
    // so THIS is the only place a bad OPENAI_REALTIME_MODEL is ever visible.
    const upstream = {
      error: {
        message: 'The model `gpt-realtime-2.1` does not exist or you do not have access to it.',
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    };
    const { deps } = harness({ call: () => response({ ok: false, status: 403, json: upstream }) });
    const result = await run(deps);

    expect(result).toMatchObject({
      ok: false,
      code: 'realtime_call_rejected',
      upstreamStatus: 403,
      upstream,
    });
  });

  it('given a non-JSON upstream error, should surface the raw text instead of dropping it', async () => {
    const { deps } = harness({
      call: () => response({ ok: false, status: 502, text: 'upstream exploded' }),
    });
    const result = await run(deps);

    expect(result).toMatchObject({ code: 'realtime_call_rejected', upstream: 'upstream exploded' });
  });

  it('given no Location header, should fail loudly rather than return an undefined call id', async () => {
    const { deps } = harness({ call: () => response({ status: 201, text: ANSWER_SDP }) });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: false, code: 'missing_call_location' });
    expect(result).not.toHaveProperty('callId');
  });

  it('given a malformed Location, should fail with a named error', async () => {
    const { deps } = harness({
      call: () =>
        response({
          status: 201,
          text: ANSWER_SDP,
          headers: { Location: '/v1/realtime/calls/sess_wrong_id_space' },
        }),
    });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: false, code: 'malformed_call_location' });
  });

  it('given an empty answer SDP, should report missing_answer_sdp', async () => {
    const { deps } = harness({
      call: () =>
        response({ status: 201, text: '', headers: { Location: `/v1/realtime/calls/${CALL_ID}` } }),
    });
    const result = await run(deps);

    expect(result).toMatchObject({ ok: false, code: 'missing_answer_sdp' });
  });

  it('given a failure before the handoff, should never hand a secret to the realtime server', async () => {
    const { deps, calls } = harness({ call: () => response({ ok: false, status: 403, json: {} }) });
    await run(deps);

    expect(byUrl(calls, `http://realtime:4000${VOICE_BRIDGE_ROUTES.attach}`)).toBeUndefined();
  });
});

describe('runCallHandshake — the secret stays on the server', () => {
  it('should not put the secret in the result on ANY path', async () => {
    const outcomes = await Promise.all([
      run(harness().deps),
      run(harness({ internalRealtimeUrl: undefined }).deps),
      run(harness({ call: () => response({ ok: false, status: 403, json: {} }) }).deps),
      run(harness({ handoff: () => response({ ok: false, status: 500 }) }).deps),
    ]);

    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
    }
  });

  it('should never log the secret', async () => {
    const { deps, logger } = harness({
      handoff: () => response({ ok: false, status: 503, json: { error: SECRET } }),
    });
    await run(deps);

    const logged = JSON.stringify([
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      (logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
  });
});
