/**
 * Attach-endpoint admission tests: what gets in, what is refused, and what the
 * registry looks like afterwards. The attach itself is injected, so no socket
 * is opened.
 *
 * The signature gate is NOT tested here — it lives in `index.ts`, ahead of this
 * handler, and is covered against the real wiring in `index.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { handleRealtimeAttachRequest, type AttachHandlerDeps } from '../voice/attach-handler';
import { RealtimeCallRegistry } from '../voice/realtime-call-registry';
import {
  RealtimeAttachError,
  type AttachOptions,
  type RealtimeCallSession,
} from '../voice/realtime-call-session';
import type { CallMeter, CallMeterOptions, MeterStopReason } from '../voice/call-metering';
import type { VoiceCallRuntime, VoiceCallRuntimeOptions } from '../voice/voice-call-runtime';

const VALID = {
  callId: 'rtc_u0_abc',
  secret: 'ek_live_secret',
  userId: 'u1',
  conversationId: 'conv1',
  tools: [{ type: 'function', name: 'read_page', description: 'Read.', parameters: {} }],
  model: 'gpt-realtime-2.1',
  subscriptionTier: 'pro',
};

/** A meter that records what it was told to do, without a ledger. */
function fakeMeter(): CallMeter & { stops: MeterStopReason[] } {
  const stops: MeterStopReason[] = [];
  return {
    stops,
    record: vi.fn(),
    touch: vi.fn(),
    settle: vi.fn(async () => {}),
    stop: vi.fn(async (reason: MeterStopReason) => {
      stops.push(reason);
    }),
    billedDollars: 0,
    stopped: false,
  };
}

function fakeSession(options: AttachOptions): RealtimeCallSession {
  let ended = false;
  return {
    callId: options.callId,
    userId: options.userId,
    conversationId: options.conversationId,
    subscribe: () => () => {},
    send: vi.fn(),
    end: vi.fn(() => {
      ended = true;
    }),
    get ended() {
      return ended;
    },
  };
}

function deps(overrides: Partial<AttachHandlerDeps> = {}): AttachHandlerDeps {
  return {
    registry: new RealtimeCallRegistry(),
    attach: vi.fn(async (options: AttachOptions) => fakeSession(options)),
    startMeter: vi.fn(async (_options: CallMeterOptions) => ({
      ok: true as const,
      meter: fakeMeter(),
    })),
    startRuntime: vi.fn(
      (_options: VoiceCallRuntimeOptions): VoiceCallRuntime => ({ stop: vi.fn(async () => {}) }),
    ),
    bridge: { send: vi.fn(async () => ({ ok: false as const, error: 'not used' })) },
    ...overrides,
  };
}

describe('handleRealtimeAttachRequest — admission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a valid payload, should attach and register the call', async () => {
    const d = deps();
    const result = await handleRealtimeAttachRequest(d, JSON.stringify(VALID));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, callId: VALID.callId });
    expect(d.registry.get(VALID.callId)?.userId).toBe('u1');
  });

  it('given a valid payload, should pass the secret and tools straight through to the attach', async () => {
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    await handleRealtimeAttachRequest(deps({ attach }), JSON.stringify(VALID));

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: VALID.callId,
        secret: VALID.secret,
        userId: 'u1',
        conversationId: 'conv1',
        tools: VALID.tools,
      }),
    );
  });

  it('given no conversationId, should still attach — binding state must not gate a call', async () => {
    const { conversationId: _omitted, ...withoutConversation } = VALID;
    const result = await handleRealtimeAttachRequest(
      deps(),
      JSON.stringify(withoutConversation),
    );

    expect(result.status).toBe(200);
  });

  it('given malformed JSON, should 400', async () => {
    const result = await handleRealtimeAttachRequest(deps(), 'not json');
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ success: false, error: 'Invalid JSON' });
  });

  it('given an API key where the ephemeral secret belongs, should 400 with a message naming the requirement', async () => {
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    const result = await handleRealtimeAttachRequest(
      deps({ attach }),
      JSON.stringify({ ...VALID, secret: 'sk-proj-an-api-key' }),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false });
    expect((result.body as { error: string }).error).toContain('ephemeral');
    // Refused at the boundary — no socket is opened for a credential that
    // cannot possibly address a call.
    expect(attach).not.toHaveBeenCalled();
  });

  it('given a session id where the call id belongs, should 400 rather than attach to nothing', async () => {
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    const result = await handleRealtimeAttachRequest(
      deps({ attach }),
      JSON.stringify({ ...VALID, callId: 'sess_u0_abc' }),
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('rtc_');
    expect(attach).not.toHaveBeenCalled();
  });

  it('given a missing userId, should 400', async () => {
    const { userId: _omitted, ...withoutUser } = VALID;
    const result = await handleRealtimeAttachRequest(deps(), JSON.stringify(withoutUser));
    expect(result.status).toBe(400);
  });

  it('given no tools key, should default to an empty tool set rather than refuse', async () => {
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    const { tools: _omitted, ...withoutTools } = VALID;

    const result = await handleRealtimeAttachRequest(
      deps({ attach }),
      JSON.stringify(withoutTools),
    );

    expect(result.status).toBe(200);
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });

  it('given the concurrency cap is reached, should 429 without attaching', async () => {
    const registry = new RealtimeCallRegistry(1);
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    const d = deps({ registry, attach });

    const first = await handleRealtimeAttachRequest(d, JSON.stringify(VALID));
    expect(first.status).toBe(200);

    const second = await handleRealtimeAttachRequest(
      d,
      JSON.stringify({ ...VALID, callId: 'rtc_second' }),
    );

    expect(second.status).toBe(429);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('given SIMULTANEOUS attaches against a cap of one, should admit exactly one', async () => {
    // The race the reservation exists for: both requests reach the cap check
    // before either finishes attaching, so a check-then-await-then-register
    // cap would admit both.
    const registry = new RealtimeCallRegistry(1);
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attach = vi.fn(async (options: AttachOptions) => {
      await inFlight;
      return fakeSession(options);
    });
    const d = deps({ registry, attach });

    const both = Promise.all([
      handleRealtimeAttachRequest(d, JSON.stringify(VALID)),
      handleRealtimeAttachRequest(d, JSON.stringify({ ...VALID, callId: 'rtc_second' })),
    ]);
    release?.();
    const [a, b] = await both;

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it('given a failed attach, should release its slot so the cap does not leak', async () => {
    const registry = new RealtimeCallRegistry(1);
    const failing = vi.fn(async () => {
      throw new RealtimeAttachError('socket_error', 'nope');
    });

    const first = await handleRealtimeAttachRequest(deps({ registry, attach: failing }), JSON.stringify(VALID));
    expect(first.status).toBe(502);
    expect(registry.reserved).toBe(0);

    // The cap must be usable again after a failure.
    const second = await handleRealtimeAttachRequest(deps({ registry }), JSON.stringify(VALID));
    expect(second.status).toBe(200);
  });

  it('given a rejected payload, should not consume a slot', async () => {
    const registry = new RealtimeCallRegistry(1);
    await handleRealtimeAttachRequest(deps({ registry }), 'not json');
    await handleRealtimeAttachRequest(
      deps({ registry }),
      JSON.stringify({ ...VALID, secret: 'sk-api-key' }),
    );

    expect(registry.reserved).toBe(0);
    expect(registry.atCapacity()).toBe(false);
  });
});

describe('handleRealtimeAttachRequest — failures and teardown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the attach fails, should 502 with the named error and register nothing', async () => {
    const registry = new RealtimeCallRegistry();
    const attach = vi.fn(async () => {
      throw new RealtimeAttachError(
        'socket_closed_before_ready',
        'Attach socket closed before ready.',
      );
    });

    const result = await handleRealtimeAttachRequest(deps({ registry, attach }), JSON.stringify(VALID));

    expect(result.status).toBe(502);
    expect((result.body as { error: string }).error).toContain('closed before ready');
    expect(registry.size).toBe(0);
  });

  it('given a non-Error throw, should still answer 502 rather than crash the endpoint', async () => {
    const attach = vi.fn(async () => {
      throw 'string failure';
    });
    const result = await handleRealtimeAttachRequest(deps({ attach }), JSON.stringify(VALID));
    expect(result.status).toBe(502);
  });

  it('given the session closes later, should deregister via the onClosed the handler wired', async () => {
    const registry = new RealtimeCallRegistry();
    let closeIt: (() => void) | undefined;
    const attach = vi.fn(async (options: AttachOptions) => {
      closeIt = () => options.onClosed?.(options.callId);
      return fakeSession(options);
    });

    await handleRealtimeAttachRequest(deps({ registry, attach }), JSON.stringify(VALID));
    expect(registry.size).toBe(1);

    closeIt?.();

    expect(registry.size).toBe(0);
  });

  it('should never echo the secret back to the caller', async () => {
    const d = deps();
    const ok = await handleRealtimeAttachRequest(d, JSON.stringify(VALID));
    const rejected = await handleRealtimeAttachRequest(
      d,
      JSON.stringify({ ...VALID, callId: 'nope' }),
    );

    expect(JSON.stringify(ok.body)).not.toContain(VALID.secret);
    expect(JSON.stringify(rejected.body)).not.toContain(VALID.secret);
  });

  it('given two concurrent calls, should register both independently', async () => {
    const registry = new RealtimeCallRegistry();
    const d = deps({ registry });

    await Promise.all([
      handleRealtimeAttachRequest(d, JSON.stringify(VALID)),
      handleRealtimeAttachRequest(d, JSON.stringify({ ...VALID, callId: 'rtc_two', userId: 'u2' })),
    ]);

    expect(registry.size).toBe(2);
    expect(registry.get(VALID.callId)?.userId).toBe('u1');
    expect(registry.get('rtc_two')?.userId).toBe('u2');
  });
});

describe('handleRealtimeAttachRequest — metering and the runtime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the credit gate refuses, should 402 WITHOUT opening a socket', async () => {
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    const result = await handleRealtimeAttachRequest(
      deps({
        attach,
        startMeter: vi.fn(async () => ({ ok: false as const, reason: 'insufficient_credits' })),
      }),
      JSON.stringify(VALID),
    );

    expect(result.status).toBe(402);
    expect((result.body as { error: string }).error).toContain('insufficient_credits');
    // The whole point of gating before the attach: an unaffordable call must
    // not get as far as a socket that has already started billing.
    expect(attach).not.toHaveBeenCalled();
  });

  it('given the user is already on their per-user limit, should 429 without attaching', async () => {
    const registry = new RealtimeCallRegistry(8);
    const attach = vi.fn(async (options: AttachOptions) => fakeSession(options));
    const d = deps({ registry, attach, maxCallsPerUser: 1 });

    const first = await handleRealtimeAttachRequest(d, JSON.stringify(VALID));
    expect(first.status).toBe(200);

    const second = await handleRealtimeAttachRequest(
      d,
      JSON.stringify({ ...VALID, callId: 'rtc_second' }),
    );

    expect(second.status).toBe(429);
    expect((second.body as { error: string }).error).toContain('this user');
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('given the per-user limit is reached by ONE user, should still admit a different user', async () => {
    // The deployment cap cannot express this and the per-user cap must not be
    // mistaken for it: one person's limit is not everyone's.
    const registry = new RealtimeCallRegistry(8);
    const d = deps({ registry, maxCallsPerUser: 1 });

    await handleRealtimeAttachRequest(d, JSON.stringify(VALID));
    const other = await handleRealtimeAttachRequest(
      d,
      JSON.stringify({ ...VALID, callId: 'rtc_other', userId: 'u2' }),
    );

    expect(other.status).toBe(200);
    expect(registry.size).toBe(2);
  });

  it('given a valid payload, should start the runtime with the seed, the secret and the call context', async () => {
    const startRuntime = vi.fn(
      (_options: VoiceCallRuntimeOptions): VoiceCallRuntime => ({ stop: vi.fn(async () => {}) }),
    );
    const seed = [
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      },
    ];

    await handleRealtimeAttachRequest(
      deps({ startRuntime }),
      JSON.stringify({ ...VALID, seed, timezone: 'America/New_York' }),
    );

    expect(startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: VALID.secret,
        seed,
        timezone: 'America/New_York',
      }),
    );
  });

  it('given the tier and model on the payload, should meter against them rather than a default', async () => {
    const startMeter = vi.fn(async (_options: CallMeterOptions) => ({
      ok: true as const,
      meter: fakeMeter(),
    }));

    await handleRealtimeAttachRequest(
      deps({ startMeter }),
      JSON.stringify({ ...VALID, model: 'gpt-realtime', subscriptionTier: 'plus' }),
    );

    expect(startMeter).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-realtime',
        tier: 'plus',
        callId: VALID.callId,
        userId: 'u1',
        conversationId: 'conv1',
      }),
    );
  });

  it('given the attach fails AFTER the hold was taken, should stop the meter so the hold is released', async () => {
    const meter = fakeMeter();
    const result = await handleRealtimeAttachRequest(
      deps({
        startMeter: vi.fn(async () => ({ ok: true as const, meter })),
        attach: vi.fn(async () => {
          throw new RealtimeAttachError('socket_error', 'nope');
        }),
      }),
      JSON.stringify(VALID),
    );

    expect(result.status).toBe(502);
    // Otherwise the reservation sits against the user's balance until its TTL,
    // for a call that never happened.
    expect(meter.stops).toEqual(['call_ended']);
  });

  it('given the session closes later, should stop the runtime as well as deregister', async () => {
    const registry = new RealtimeCallRegistry();
    const stop = vi.fn(async () => {});
    let closeIt: (() => void) | undefined;
    const attach = vi.fn(async (options: AttachOptions) => {
      closeIt = () => options.onClosed?.(options.callId);
      return fakeSession(options);
    });

    await handleRealtimeAttachRequest(
      deps({ registry, attach, startRuntime: vi.fn(() => ({ stop })) }),
      JSON.stringify(VALID),
    );

    closeIt?.();

    expect(registry.size).toBe(0);
    expect(stop).toHaveBeenCalledWith('call_ended');
  });

  it('given the meter hits a limit, should tear the call down through the runtime', async () => {
    // The meter owns the ledger, not the socket, so a limit it hits has to be
    // routed to the thing that can also hang up the browser.
    let onLimit: ((reason: MeterStopReason, message: string) => void) | undefined;
    const stop = vi.fn(async () => {});

    await handleRealtimeAttachRequest(
      deps({
        startMeter: vi.fn(async (options: CallMeterOptions) => {
          onLimit = options.onLimit;
          return { ok: true as const, meter: fakeMeter() };
        }),
        startRuntime: vi.fn(() => ({ stop })),
      }),
      JSON.stringify(VALID),
    );

    onLimit?.('idle_timeout', 'silence');

    expect(stop).toHaveBeenCalledWith('idle_timeout');
  });

  it('given no model, should 400 — an unpriced call bills nothing', async () => {
    const { model: _omitted, ...withoutModel } = VALID;
    const result = await handleRealtimeAttachRequest(deps(), JSON.stringify(withoutModel));
    expect(result.status).toBe(400);
  });

  it('given no seed, should default to none rather than refuse', async () => {
    const startRuntime = vi.fn(
      (_options: VoiceCallRuntimeOptions): VoiceCallRuntime => ({ stop: vi.fn(async () => {}) }),
    );
    const result = await handleRealtimeAttachRequest(deps({ startRuntime }), JSON.stringify(VALID));

    expect(result.status).toBe(200);
    expect(startRuntime).toHaveBeenCalledWith(expect.objectContaining({ seed: [] }));
  });
});
