import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UIMessageChunk } from 'ai';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { loggers } from '@pagespace/lib/logging/logger-config';
import { createTurnTimer } from '../turn-timing';

const textDelta = { type: 'text-delta', id: 't1', delta: 'hi' } as UIMessageChunk;
const startFrame = { type: 'start' } as UIMessageChunk;

const warnMessages = () => vi.mocked(loggers.ai.warn).mock.calls.map(([message]) => message);

describe('createTurnTimer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits time to first token into preflight and provider', () => {
    const timer = createTurnTimer({ receivedAt: Date.now() });
    vi.advanceTimersByTime(300);
    timer.mark('permissions');
    vi.advanceTimersByTime(200);
    timer.modelRequest();
    vi.advanceTimersByTime(1_500);
    timer.observeChunk(startFrame);
    timer.observeChunk(textDelta);

    expect(timer.summary()).toEqual({
      firstTokenMs: 2_000,
      preflightMs: 500,
      providerMs: 1_500,
      attemptsBeforeFirstToken: 1,
      marks: { permissions: 300 },
    });
    expect(loggers.ai.info).toHaveBeenCalledWith(
      'AI turn first token',
      expect.objectContaining({ firstTokenMs: 2_000 }),
    );
  });

  it('ignores our own framing and data parts when detecting the first token', () => {
    const timer = createTurnTimer({ receivedAt: Date.now() });
    timer.modelRequest();
    timer.observeChunk(startFrame);
    timer.observeChunk({ type: 'data-command-execution', data: {} } as UIMessageChunk);

    expect(timer.summary().firstTokenMs).toBeNull();
  });

  it('names the phase a stuck turn is waiting in, while it is still stuck', () => {
    const timer = createTurnTimer({ receivedAt: Date.now() });
    timer.mark('credit_gate');
    vi.advanceTimersByTime(10_000);

    expect(loggers.ai.warn).toHaveBeenCalledWith(
      'AI turn slow: no first token yet',
      expect.objectContaining({ lastPhase: 'credit_gate', waitingOn: 'preflight' }),
    );

    timer.modelRequest();
    vi.advanceTimersByTime(20_000);

    expect(loggers.ai.warn).toHaveBeenLastCalledWith(
      'AI turn slow: no first token yet',
      expect.objectContaining({ lastPhase: 'model_request', waitingOn: 'provider' }),
    );
  });

  it('stops the watchdog at the first token and logs a slow one at warn', () => {
    const timer = createTurnTimer({ receivedAt: Date.now() });
    timer.modelRequest();
    vi.advanceTimersByTime(12_000);
    timer.observeChunk(textDelta);
    vi.advanceTimersByTime(600_000);

    expect(warnMessages()).toEqual(['AI turn slow: no first token yet', 'AI turn first token']);
  });

  it('counts retries that happened before the first token', () => {
    const timer = createTurnTimer({ receivedAt: Date.now() });
    timer.modelRequest();
    timer.modelRequest();
    timer.observeChunk(textDelta);
    timer.modelRequest();

    expect(timer.summary().attemptsBeforeFirstToken).toBe(2);
  });

  it('leaves a handed-off turn for the pump to end', () => {
    const timer = createTurnTimer({ receivedAt: Date.now() });
    timer.handOff();
    timer.endUnlessHandedOff('no_generation');
    vi.advanceTimersByTime(10_000);

    expect(warnMessages()).toEqual(['AI turn slow: no first token yet']);
  });

  it('ends a fast early return quietly and a slow one loudly', () => {
    const fast = createTurnTimer({ receivedAt: Date.now() });
    fast.endUnlessHandedOff('no_generation');
    expect(loggers.ai.warn).not.toHaveBeenCalled();
    expect(loggers.ai.debug).toHaveBeenCalledWith('AI turn ended with no model output', expect.anything());

    const slow = createTurnTimer({ receivedAt: Date.now() - 15_000 });
    slow.end('no_generation');
    expect(warnMessages()).toEqual(['AI turn ended with no model output']);
    vi.advanceTimersByTime(600_000);
    expect(warnMessages()).toEqual(['AI turn ended with no model output']);
  });
});
