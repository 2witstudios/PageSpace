/**
 * Metering tests. No ledger, no timers, no clock: the gate, the settle sink,
 * the hold release and every timer are injected, so what is exercised is the
 * decision tree — hold, accumulate, settle, re-hold, stop — rather than
 * Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  startCallMeter,
  type CallMeter,
  type CallMeterOptions,
  type MeterStopReason,
} from '../call-metering';
import type { RealtimeUsage } from '@pagespace/lib/monitoring/voice-pricing';

const usage = (over: Partial<RealtimeUsage> = {}): RealtimeUsage => ({
  input_tokens: 100,
  output_tokens: 50,
  total_tokens: 150,
  input_token_details: { text_tokens: 20, audio_tokens: 80, image_tokens: 0 },
  output_token_details: { text_tokens: 10, audio_tokens: 40 },
  ...over,
});

/** Hand-cranked timers: nothing fires until a test says so. */
function fakeTimers() {
  const intervals: { fn: () => void; ms: number; id: number }[] = [];
  const timeouts: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;

  return {
    intervals,
    timeouts,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      intervals.push({ fn, ms, id });
      return id as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearIntervalFn: ((id: unknown) => {
      const index = intervals.findIndex((entry) => entry.id === id);
      if (index >= 0) intervals.splice(index, 1);
    }) as unknown as typeof clearInterval,
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timeouts.push({ fn, ms, id });
      return id as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: unknown) => {
      const index = timeouts.findIndex((entry) => entry.id === id);
      if (index >= 0) timeouts.splice(index, 1);
    }) as unknown as typeof clearTimeout,
    /** The settle interval is created first, the idle sweep second. */
    fireSettle: () => intervals[0]?.fn(),
    fireIdleSweep: () => intervals[1]?.fn(),
    fireDurationCap: () => timeouts[0]?.fn(),
  };
}

type Harness = ReturnType<typeof fakeTimers> & {
  gate: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  limits: { reason: MeterStopReason; message: string }[];
  now: () => number;
  advance: (ms: number) => void;
};

function harness(over: Partial<CallMeterOptions> = {}) {
  const timers = fakeTimers();
  let holdCounter = 0;
  const gate = vi.fn(async () => ({
    allowed: true,
    reason: 'ok' as const,
    holdId: `hold-${++holdCounter}`,
  }));
  // `trackUsage` reports whether the usage row landed; a stub resolving with
  // nothing would claim a LOST window, which the meter now treats as a failed settle.
  const track = vi.fn(async () => ({ persisted: true, creditsSettled: true }));
  const release = vi.fn(async () => {});
  const limits: { reason: MeterStopReason; message: string }[] = [];
  let clock = 1_000;

  const options: CallMeterOptions = {
    callId: 'rtc_1',
    userId: 'u1',
    conversationId: 'conv1',
    tier: 'pro',
    model: 'gpt-realtime-2.1',
    onLimit: (reason, message) => limits.push({ reason, message }),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => clock,
    gate: gate as unknown as CallMeterOptions['gate'],
    track: track as unknown as CallMeterOptions['track'],
    release: release as unknown as CallMeterOptions['release'],
    ...over,
  };

  const h: Harness = {
    ...timers,
    gate,
    track,
    release,
    limits,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };

  return { options, h };
}

/**
 * Start a meter that is expected to pass the gate, and hand back the meter
 * itself.
 *
 * The narrowing lives here rather than in every test because `startCallMeter`
 * returns a refusal union: written inline it was the same unreachable `if
 * (!started.ok) throw` twenty-two times, which is twenty-two copies of a
 * sentence about a case each of those tests has already ruled out by
 * construction. Tests that DO exercise a refusal call `startCallMeter` directly.
 */
async function startedMeter(options: CallMeterOptions): Promise<CallMeter> {
  const started = await startCallMeter(options);
  if (!started.ok) throw new Error(`expected a meter, but the gate refused: ${started.reason}`);
  return started.meter;
}

describe('startCallMeter — the opening hold', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the gate allows, should start and hold', async () => {
    const { options, h } = harness();
    const started = await startCallMeter(options);

    expect(started.ok).toBe(true);
    expect(h.gate).toHaveBeenCalledTimes(1);
  });

  it('given the gate refuses, should refuse with its reason and start nothing', async () => {
    const { options, h } = harness({
      gate: (async () => ({ allowed: false, reason: 'insufficient_credits' })) as unknown as CallMeterOptions['gate'],
    });
    const started = await startCallMeter(options);

    expect(started).toEqual({ ok: false, reason: 'insufficient_credits' });
    expect(h.intervals).toHaveLength(0);
    expect(h.timeouts).toHaveLength(0);
  });

  it('should gate on the PER-USER concurrency limit, not just the balance', async () => {
    const { options, h } = harness();
    await startCallMeter(options);

    expect(h.gate).toHaveBeenCalledWith(
      'u1',
      'pro',
      expect.objectContaining({ maxInFlight: expect.any(Number), estCostCents: expect.any(Number) }),
    );
  });
});

describe('startCallMeter — settling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given usage across two responses, should settle their SUM once', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    meter.record(usage());
    await meter.settle();

    expect(h.track).toHaveBeenCalledTimes(1);
    const call = h.track.mock.calls[0][0];
    expect(call.inputTokens).toBe(200);
    expect(call.outputTokens).toBe(100);
    expect(call.providerCostDollars).toBeGreaterThan(0);
  });

  it('should settle against the hold it opened, then take a NEW hold for the next window', async () => {
    // `trackUsage` takes ownership of the hold, so a long call that did not
    // re-hold would run the rest of its length unreserved.
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.track.mock.calls[0][0].holdId).toBe('hold-1');
    expect(h.gate).toHaveBeenCalledTimes(2);

    meter.record(usage());
    await meter.settle();
    expect(h.track.mock.calls[1][0].holdId).toBe('hold-2');
  });

  it('given nothing was spent, should settle nothing and keep the existing hold', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    await meter.settle();

    expect(h.track).not.toHaveBeenCalled();
    // No second gate call: the hold was never consumed, so there is nothing to
    // replace.
    expect(h.gate).toHaveBeenCalledTimes(1);
  });

  it('given the re-hold is refused, should report credit exhaustion as a limit', async () => {
    let calls = 0;
    const gate = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { allowed: true, reason: 'ok' as const, holdId: 'hold-1' }
        : { allowed: false, reason: 'insufficient_credits' as const };
    });
    const { options, h } = harness({ gate: gate as unknown as CallMeterOptions['gate'] });
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.limits).toEqual([
      { reason: 'credit_exhausted', message: expect.any(String) },
    ]);
  });

  it('given the settle sink throws, should keep the call up rather than take it down', async () => {
    const { options, h } = harness({
      track: (async () => {
        throw new Error('ledger unreachable');
      }) as unknown as CallMeterOptions['track'],
    });
    const meter = await startedMeter(options);

    meter.record(usage());
    await expect(meter.settle()).resolves.toBeUndefined();
    expect(h.limits).toEqual([]);
  });

  it('should settle on its own interval without being asked', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    h.fireSettle();
    await meter.settle();

    expect(h.track).toHaveBeenCalledTimes(1);
  });

  it('given overlapping settles, should serialize them so one window is never billed twice', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    await Promise.all([meter.settle(), meter.settle(), meter.settle()]);

    expect(h.track).toHaveBeenCalledTimes(1);
  });

  it('should stamp the usage row as deterministic voice-realtime spend', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.track.mock.calls[0][0]).toMatchObject({
      provider: 'openai_voice',
      model: 'gpt-realtime-2.1',
      source: 'voice',
      costSource: 'list_price',
      conversationId: 'conv1',
      metadata: expect.objectContaining({ type: 'voice_realtime', callId: 'rtc_1' }),
    });
  });

  it('given an unpriceable model, should still settle — at zero, loudly', async () => {
    const { options, h } = harness({ model: 'gpt-realtime-9-unreleased' });
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.track.mock.calls[0][0].providerCostDollars).toBe(0);
  });

  it('given totals with NO modality attached, should still settle and report the zero-billed shape', async () => {
    // A payload that reports tokens but attributes none of them: priced at zero
    // by design, because audio input costs eight times text input and guessing
    // over-charges half the time. The detail fields are absent entirely here,
    // so the settle also has to survive reading through them.
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    await meter.settle();

    const settled = h.track.mock.calls[0][0];
    expect(settled.providerCostDollars).toBe(0);
    expect(settled.inputTokens).toBe(100);
    expect(settled.outputTokens).toBe(50);
    expect(settled.cachedInputTokens).toBe(0);
    expect(settled.metadata.audioInputTokens).toBe(0);
    expect(settled.metadata.audioOutputTokens).toBe(0);
  });

  it('given a gate that allows without a hold id, should settle with no hold to consume', async () => {
    // The gate short-circuits to "allowed, unlimited" when billing is off, and
    // there is no reservation to hand the settle in that case.
    const { options, h } = harness({
      gate: (async () => ({ allowed: true, reason: 'ok' })) as unknown as CallMeterOptions['gate'],
    });
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track.mock.calls[0][0]).not.toHaveProperty('holdId');
  });

  it('given an UNBOUND call, should settle without a conversation id', async () => {
    const { options, h } = harness({ conversationId: undefined });
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.track.mock.calls[0][0]).not.toHaveProperty('conversationId');
  });

  it('given a settle that rejects with a NON-Error, should keep the call up', async () => {
    // The user is mid-sentence. A failed settle is a logged, unbilled window,
    // never a dropped call — including when the rejection is not an Error.
    const { options, h } = harness({
      track: (async () => {
        throw 'ledger string blip';
      }) as unknown as CallMeterOptions['track'],
    });
    const meter = await startedMeter(options);

    meter.record(usage());
    await expect(meter.settle()).resolves.toBeUndefined();
    // The hold is released rather than left against the balance until its TTL.
    expect(h.release).toHaveBeenCalled();
  });

  it('given a settle failure whose hold release ALSO rejects, should let the hold expire quietly', async () => {
    const { options } = harness({
      track: (async () => {
        throw new Error('ledger unreachable');
      }) as unknown as CallMeterOptions['track'],
      release: (async () => {
        throw 'release string blip';
      }) as unknown as CallMeterOptions['release'],
    });
    const meter = await startedMeter(options);

    meter.record(usage());
    // Both failures are logged; neither may propagate into a live call.
    await expect(meter.settle()).resolves.toBeUndefined();
  });
});

describe('startCallMeter — limits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given no activity for longer than the idle timeout, should report an idle limit', async () => {
    const { options, h } = harness({ idleTimeoutMs: 10_000 });
    const meter = await startedMeter(options);

    h.advance(10_001);
    h.fireIdleSweep();

    expect(h.limits.map((limit) => limit.reason)).toEqual(['idle_timeout']);
  });

  it('given someone is still talking, should NOT report an idle limit', async () => {
    const { options, h } = harness({ idleTimeoutMs: 10_000 });
    const meter = await startedMeter(options);

    h.advance(9_000);
    meter.touch();
    h.advance(9_000);
    h.fireIdleSweep();

    expect(h.limits).toEqual([]);
  });

  it('given recorded usage, should count as activity', async () => {
    // Usage means a response happened, which means someone is in the room.
    const { options, h } = harness({ idleTimeoutMs: 10_000 });
    const meter = await startedMeter(options);

    h.advance(9_000);
    meter.record(usage());
    h.advance(9_000);
    h.fireIdleSweep();

    expect(h.limits).toEqual([]);
  });

  it('given the duration cap elapses, should report it', async () => {
    const { options, h } = harness({ maxDurationMs: 600_000 });
    const meter = await startedMeter(options);

    h.fireDurationCap();

    expect(h.limits.map((limit) => limit.reason)).toEqual(['duration_cap']);
    expect(h.timeouts[0].ms).toBe(600_000);
  });
});

describe('startCallMeter — stopping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should settle the FINAL window before releasing anything', async () => {
    // The last thing said in a call is usually the most expensive part of it.
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.stop('call_ended');

    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track.mock.calls[0][0].inputTokens).toBe(100);
  });

  it('given an unspent hold at the end, should release it rather than leave it to its TTL', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    await meter.stop('call_ended');

    expect(h.release).toHaveBeenCalledWith('hold-1');
  });

  it('given the final window WAS settled, should release nothing and take no fresh hold', async () => {
    // `trackUsage` already took the reservation on the way out, and a call that
    // has stopped has no next window to reserve for. Re-holding here would open
    // a reservation nothing will ever settle.
    const { options, h } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.stop('call_ended');

    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.gate).toHaveBeenCalledTimes(1);
  });

  it('given the settle threw, should release that hold and still re-hold for the next window', async () => {
    // Whether the sink consumed the reservation before throwing is unknowable,
    // and releasing covers both: an already-settled hold deletes nothing, and
    // an unreached one is freed instead of pinning the balance for its TTL.
    const { options, h } = harness({
      track: (async () => {
        throw new Error('ledger unreachable');
      }) as unknown as CallMeterOptions['track'],
    });
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();

    expect(h.release).toHaveBeenCalledWith('hold-1');
    expect(h.gate).toHaveBeenCalledTimes(2);
  });

  it('should clear every timer so a stopped call cannot fire a limit', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    await meter.stop('duration_cap');

    expect(h.intervals).toHaveLength(0);
    expect(h.timeouts).toHaveLength(0);
  });

  it('should be idempotent', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    await meter.stop('call_ended');
    await meter.stop('call_ended');

    expect(h.release).toHaveBeenCalledTimes(1);
    expect(meter.stopped).toBe(true);
  });

  it('given a failing hold release, should not throw out of teardown', async () => {
    const { options } = harness({
      release: (async () => {
        throw new Error('ledger unreachable');
      }) as unknown as CallMeterOptions['release'],
    });
    const meter = await startedMeter(options);

    await expect(meter.stop('call_ended')).resolves.toBeUndefined();
  });

  it('should report the total billed across every settle', async () => {
    const { options } = harness();
    const meter = await startedMeter(options);

    meter.record(usage());
    await meter.settle();
    const afterFirst = meter.billedDollars;

    meter.record(usage());
    await meter.settle();

    expect(afterFirst).toBeGreaterThan(0);
    expect(meter.billedDollars).toBeCloseTo(afterFirst * 2, 10);
  });

  it('given the meter is stopped, should ignore further usage', async () => {
    const { options, h } = harness();
    const meter = await startedMeter(options);

    await meter.stop('call_ended');
    h.track.mockClear();
    meter.record(usage());
    await meter.settle();

    expect(h.track).not.toHaveBeenCalled();
  });
});
