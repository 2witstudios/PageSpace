import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createShellIo,
  planColdShellReadAnswer,
  type RealtimeShellIoTransport,
} from '../shell-io';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn() } },
}));

const SHELL_ID = 'shell-row-1';
const USER_ID = 'user-1';

function makeTransport(over: Partial<RealtimeShellIoTransport> = {}): RealtimeShellIoTransport {
  return {
    read: vi.fn(async () => ({ success: true, live: true, hasOutput: true, viewers: 1, output: 'out' })),
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
    expect(transport.read).toHaveBeenCalledWith({ shellId: SHELL_ID, limit: 100, start: true, userId: USER_ID });
  });

  it('given a COLD-TAIL record, should NOT ask for a start — the dead shell\'s final scrollback is the answer', async () => {
    const transport = makeTransport({
      read: vi.fn(async () => ({ success: true, live: false, hasOutput: false, viewers: 0, output: '' })),
    });
    const io = createShellIo(transport);
    const cold = { tail: 'final output', at: new Date('2026-07-28T00:00:00Z'), hasOutput: true };
    const result = await io.read({ shellId: SHELL_ID, lines: 100, userId: USER_ID, cold });
    if (!result.ok) throw new Error('expected ok');
    expect(transport.read).toHaveBeenCalledWith({ shellId: SHELL_ID, limit: 100 });
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
        read: vi.fn(async () => ({ success: true, live: true, hasOutput: false, viewers: 0, output: '', started: true as const })),
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

  it('given a transport non-answer, should report the input was NOT delivered', async () => {
    const io = createShellIo(makeTransport({ send: vi.fn(async () => null) }));
    const result = await io.send({ shellId: SHELL_ID, keystrokes: 'x', userId: USER_ID });
    expect(result.ok).toBe(false);
  });
});
