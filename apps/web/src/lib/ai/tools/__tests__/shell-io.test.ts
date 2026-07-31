import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createShellIo,
  planColdShellReadAnswer,
  realtimeShellIoTransport,
  type RealtimeShellIoTransport,
} from '../shell-io';
import { SHELL_BRIDGE_ROUTES } from '@pagespace/lib/agent-sessions/contract';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn() } },
}));

const SHELL_ID = 'shell-row-1';
const USER_ID = 'user-1';

function makeTransport(over: Partial<RealtimeShellIoTransport> = {}): RealtimeShellIoTransport {
  return {
    read: vi.fn(async () => ({ success: true, shells: [{ shellId: SHELL_ID, live: true, hasOutput: true, viewers: 1, output: 'out' }] })),
    send: vi.fn(async () => ({ success: true, live: true, delivered: true })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('read', () => {
  it('should read a live shell\'s scrollback with the untrusted framing applied', async () => {
    const transport = makeTransport();
    const io = createShellIo(transport);
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID });
    if (!result.ok) throw new Error('expected ok');
    expect(result.live).toBe(true);
    expect(result.output).toContain('out');
    expect(transport.read).toHaveBeenCalledWith({ shellIds: [SHELL_ID], limit: 100, start: true, userId: USER_ID });
  });

  it('given a COLD-TAIL record, should NOT ask for a start — the dead shell\'s final scrollback is the answer', async () => {
    const transport = makeTransport({
      read: vi.fn(async () => ({ success: true, shells: [{ shellId: SHELL_ID, live: false, hasOutput: false, viewers: 0, output: '' }] })),
    });
    const io = createShellIo(transport);
    const cold = { tail: 'final output', at: new Date('2026-07-28T00:00:00Z'), hasOutput: true };
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID, cold });
    if (!result.ok) throw new Error('expected ok');
    expect(transport.read).toHaveBeenCalledWith({ shellIds: [SHELL_ID], limit: 100 });
    expect(result.live).toBe(false);
    expect(result.output).toContain('final output');
    expect(result.note).toContain('ENDED');
  });

  it('given a transport non-answer, should refuse rather than degrade into "cold"', async () => {
    const io = createShellIo(makeTransport({ read: vi.fn(async () => null) }));
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID });
    expect(result.ok).toBe(false);
  });

  it('given a started-by-this-read shell, should say so', async () => {
    const io = createShellIo(
      makeTransport({
        read: vi.fn(async () => ({ success: true, shells: [{ shellId: SHELL_ID, live: true, hasOutput: false, viewers: 0, output: '', started: true as const }] })),
      }),
    );
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID });
    if (!result.ok) throw new Error('expected ok');
    expect(result.started).toBe(true);
    expect(result.note).toContain('started');
  });
});

describe('planColdShellReadAnswer — three distinct empties', () => {
  it('no cold record: never-ran/unstartable, honestly ambiguous', () => {
    const answer = planColdShellReadAnswer({ lines: 100 });
    expect(answer.hasOutput).toBe(false);
    expect(answer.note).toContain('NOT the same as it having produced no output');
  });

  it('cold with output the ring dropped: hasOutput true, empty output, its own note', () => {
    const answer = planColdShellReadAnswer({
      lines: 100,
      cold: { tail: '', at: new Date(), hasOutput: true },
    });
    expect(answer.hasOutput).toBe(true);
    expect(answer.output).toBe('');
    expect(answer.note).toContain('pushed it out');
  });

  it('cold with a retained tail: the tail, limited', () => {
    const answer = planColdShellReadAnswer({
      lines: 2,
      cold: { tail: 'a\nb\nc\nd', at: new Date(), hasOutput: true },
    });
    expect(answer.output).toContain('d');
    expect(answer.output).not.toContain('a\nb');
  });
});

describe('the realtime hop', () => {
  // This is the test that was missing. Both sides of this hop are unit-tested
  // against a mock of the other, so a client posting to a route the server does
  // not serve produces two green suites and a feature that has never once
  // worked. Pin the wire contract itself.
  it('should post to routes the realtime server actually serves', () => {
    expect(SHELL_BRIDGE_ROUTES.read).toBe('/api/shell-read');
    expect(SHELL_BRIDGE_ROUTES.input).toBe('/api/shell-input');
    expect(SHELL_BRIDGE_ROUTES.activity).toBe('/api/shell-activity');
  });

  it('given no INTERNAL_REALTIME_URL, should answer null rather than throw', async () => {
    const previous = process.env.INTERNAL_REALTIME_URL;
    delete process.env.INTERNAL_REALTIME_URL;
    try {
      expect(await realtimeShellIoTransport.read({ shellIds: [SHELL_ID], limit: 10 })).toBeNull();
    } finally {
      if (previous !== undefined) process.env.INTERNAL_REALTIME_URL = previous;
    }
  });
});

describe('read — the endpoint answers per shell', () => {
  it('given an answer that omits the id we asked about, should refuse rather than report it dead', async () => {
    // A `success: true` with no matching entry is the endpoint declining to say
    // anything about this shell. Reading that as "not live" would report a
    // running build as finished — the one wrong answer this tool must never give.
    const io = createShellIo(makeTransport({ read: vi.fn(async () => ({ success: true, shells: [] })) }));
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID });
    expect(result.ok).toBe(false);
  });

  it('given entries for several shells, should read the one it named', async () => {
    const io = createShellIo(
      makeTransport({
        read: vi.fn(async () => ({
          success: true,
          shells: [
            { shellId: 'other-shell', live: true, hasOutput: true, viewers: 0, output: 'WRONG' },
            { shellId: SHELL_ID, live: true, hasOutput: true, viewers: 1, output: 'mine' },
          ],
        })),
      }),
    );
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID });
    if (!result.ok) throw new Error('expected ok');
    expect(result.output).toContain('mine');
    expect(result.output).not.toContain('WRONG');
  });
});

describe('send', () => {
  it('should type keystrokes with start semantics and the acting user attached', async () => {
    const transport = makeTransport();
    const io = createShellIo(transport);
    const result = await io.send({ shellId: SHELL_ID, keystrokes: 'ls\n', userId: USER_ID });
    expect(result.ok).toBe(true);
    expect(transport.send).toHaveBeenCalledWith({ shellId: SHELL_ID, input: 'ls\n', start: true, userId: USER_ID });
  });

  it('given a shell that could not be started, should report NOTHING was typed', async () => {
    const io = createShellIo(
      makeTransport({ send: vi.fn(async () => ({ success: true, live: false, delivered: false })) }),
    );
    const result = await io.send({ shellId: SHELL_ID, keystrokes: 'x', userId: USER_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('Nothing was delivered');
  });

  it('given a refusal WITH a reason, should state it instead of guessing between two causes', async () => {
    const io = createShellIo(
      makeTransport({
        send: vi.fn(async () => ({
          success: true,
          live: false,
          delivered: false,
          reason: 'Live agent-session limit reached for your plan.',
        })),
      }),
    );
    const result = await io.send({ shellId: SHELL_ID, keystrokes: 'x', userId: USER_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('Live agent-session limit reached for your plan.');
    // The old text offered "out of credits OR at the limit" — an agent cannot
    // act on a disjunction where only one arm is worth waiting out.
    expect(result.error).not.toContain('may be out of credits');
  });

  it('given a transport non-answer, should report the input was NOT delivered', async () => {
    const io = createShellIo(makeTransport({ send: vi.fn(async () => null) }));
    const result = await io.send({ shellId: SHELL_ID, keystrokes: 'x', userId: USER_ID });
    expect(result.ok).toBe(false);
  });
});
