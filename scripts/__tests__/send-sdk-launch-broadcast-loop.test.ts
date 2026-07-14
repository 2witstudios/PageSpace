import { describe, it, expect, vi } from 'vitest';
import {
  LedgerWriteFailed,
  runBroadcast,
  type BroadcastUser,
  type SentLedgerEntry,
} from '../lib/sdk-launch-broadcast';

/**
 * The send loop is the code that can email someone twice, or email someone we
 * were told never to email. These tests exercise it with the database and the
 * mail provider replaced by spies, so the orderings it depends on are pinned.
 */

interface Harness {
  sent: string[];
  recorded: SentLedgerEntry[];
  logs: string[];
  errorLogs: string[];
  sendOne: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}

function run(
  rows: BroadcastUser[],
  overrides: Partial<Parameters<typeof runBroadcast>[0]> = {},
): { result: ReturnType<typeof runBroadcast>; h: Harness } {
  const h: Harness = {
    sent: [],
    recorded: [],
    logs: [],
    errorLogs: [],
    sendOne: vi.fn(),
    record: vi.fn(),
  };

  h.sendOne.mockImplementation(async ({ email }: { email: string }) => {
    h.sent.push(email);
  });
  h.record.mockImplementation(async (entry: SentLedgerEntry) => {
    h.recorded.push(entry);
  });

  const result = runBroadcast({
    live: true,
    limit: null,
    delayMs: 0,
    rows,
    decrypt: async (row) => row,
    isValidEmail: (email) => email.includes('@'),
    alreadySent: new Set(),
    suppressed: new Set(),
    optedOut: new Set(),
    sendOne: h.sendOne,
    renderOne: async () => '<html>rendered</html>',
    record: h.record,
    now: () => '2026-07-14T00:00:00.000Z',
    sleep: async () => {},
    log: (m) => h.logs.push(m),
    logError: (m) => h.errorLogs.push(m),
    ...overrides,
  });

  return { result, h };
}

const user = (id: string, email: string, name?: string): BroadcastUser => ({ id, email, name });

describe('runBroadcast — live send', () => {
  it('given valid recipients, should send to each and record every send', async () => {
    const { result, h } = run([user('u1', 'ada@example.com'), user('u2', 'grace@example.com')]);

    await expect(result).resolves.toMatchObject({ sent: 2, attempted: 2, errors: [] });
    expect(h.sent).toEqual(['ada@example.com', 'grace@example.com']);
    expect(h.recorded.map((e) => e.email)).toEqual(['ada@example.com', 'grace@example.com']);
  });

  it('should record a send IMMEDIATELY after it succeeds, before moving on', async () => {
    // If the loop sent everyone and recorded at the end, a crash midway would
    // lose the record of every send that already went out.
    const order: string[] = [];
    const { result } = run([user('u1', 'ada@example.com'), user('u2', 'grace@example.com')], {
      sendOne: vi.fn(async ({ email }: { email: string }) => {
        order.push(`send:${email}`);
      }),
      record: vi.fn(async (entry: SentLedgerEntry) => {
        order.push(`record:${entry.email}`);
      }),
    });
    await result;

    expect(order).toEqual([
      'send:ada@example.com',
      'record:ada@example.com',
      'send:grace@example.com',
      'record:grace@example.com',
    ]);
  });

  it('given a ledger write that fails after a send, should abort rather than mail anyone else', async () => {
    // The email is already gone and nothing remembers it. Continuing would risk
    // re-sending it on the next run, so the run must stop and say so.
    const { result, h } = run([user('u1', 'ada@example.com'), user('u2', 'grace@example.com')], {
      record: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    await expect(result).rejects.toBeInstanceOf(LedgerWriteFailed);
    // Only the first recipient was mailed; the loop stopped before the second.
    expect(h.sent).toEqual(['ada@example.com']);
  });

  it('the fatal ledger error should name the entry the operator has to write down', async () => {
    const { result } = run([user('u1', 'ada@example.com')], {
      record: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    await expect(result).rejects.toMatchObject({
      entry: { email: 'ada@example.com', userId: 'u1', sentAt: '2026-07-14T00:00:00.000Z' },
    });
  });

  it('given a provider failure, should NOT record it — so a re-run retries exactly that address', async () => {
    const { result, h } = run([user('u1', 'ada@example.com'), user('u2', 'grace@example.com')], {
      sendOne: vi.fn(async ({ email }: { email: string }) => {
        if (email === 'ada@example.com') throw new Error('rate limited');
      }),
    });

    const out = await result;

    expect(out.errors).toEqual(['ada@example.com: rate limited']);
    expect(out.sent).toBe(1);
    // Nothing recorded for the failed address; the successful one is recorded.
    expect(h.recorded.map((e) => e.email)).toEqual(['grace@example.com']);
  });

  it('given two accounts sharing one address, should mail it once', async () => {
    // Otherwise one human receives the announcement twice in the same run.
    const { result, h } = run([user('u1', 'ada@example.com'), user('u2', 'Ada@Example.com')]);

    const out = await result;

    expect(h.sent).toEqual(['ada@example.com']);
    expect(out.skipped['already-sent']).toBe(1);
  });
});

describe('runBroadcast — exclusions', () => {
  it('should never mail a suppressed, opted-out, already-sent, or invalid address', async () => {
    const { result, h } = run(
      [
        user('u1', 'erased@example.com'),
        user('u2', 'optedout@example.com'),
        user('u3', 'done@example.com'),
        user('u4', 'not-an-email'),
        user('u5', 'ada@example.com'),
      ],
      {
        suppressed: new Set(['erased@example.com']),
        optedOut: new Set(['u2']),
        alreadySent: new Set(['done@example.com']),
      },
    );

    const out = await result;

    expect(h.sent).toEqual(['ada@example.com']);
    expect(out.skipped).toEqual({
      suppressed: 1,
      'opted-out': 1,
      'already-sent': 1,
      'invalid-email': 1,
    });
  });
});

describe('runBroadcast — --limit', () => {
  it('should count ATTEMPTS, not successes, so an outage cannot walk the whole audience', async () => {
    // A --limit=2 canary where every send fails must still stop after 2 attempts.
    const rows = [
      user('u1', 'a@example.com'),
      user('u2', 'b@example.com'),
      user('u3', 'c@example.com'),
      user('u4', 'd@example.com'),
    ];
    const failingSend = vi.fn(async () => {
      throw new Error('provider down');
    });
    const { result } = run(rows, { limit: 2, sendOne: failingSend });

    const out = await result;

    expect(out.attempted).toBe(2);
    // Two attempts, both failed — and it stopped, rather than trying all four.
    expect(failingSend).toHaveBeenCalledTimes(2);
    expect(out.errors).toHaveLength(2);
  });

  it('should not let skipped rows consume the limit budget', async () => {
    // Suppressed/already-sent rows are not attempts; a --limit=1 run should still
    // reach the first genuinely mailable recipient.
    const { result, h } = run(
      [user('u1', 'erased@example.com'), user('u2', 'done@example.com'), user('u3', 'ada@example.com')],
      {
        limit: 1,
        suppressed: new Set(['erased@example.com']),
        alreadySent: new Set(['done@example.com']),
      },
    );

    await result;

    expect(h.sent).toEqual(['ada@example.com']);
  });
});

describe('runBroadcast — dry run', () => {
  it('should render but never send or record', async () => {
    const { result, h } = run([user('u1', 'ada@example.com')], { live: false });

    const out = await result;

    expect(out.sent).toBe(1);
    expect(h.sendOne).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('given a template that throws, should report it as an error rather than crash the run', async () => {
    const { result } = run([user('u1', 'ada@example.com'), user('u2', 'grace@example.com')], {
      live: false,
      renderOne: vi.fn(async ({ email }: { email: string }) => {
        if (email === 'ada@example.com') throw new Error('bad template');
        return '<html/>';
      }),
    });

    const out = await result;

    expect(out.errors).toEqual(['ada@example.com: bad template']);
    expect(out.sent).toBe(1);
  });
});

describe('runBroadcast — undecryptable rows', () => {
  it('should skip a row whose PII will not decrypt and keep going', async () => {
    // A single corrupt ciphertext must not abort a broadcast that is already
    // part-way through sending.
    const { result, h } = run([user('u1', 'bad@example.com'), user('u2', 'ada@example.com')], {
      decrypt: async (row: BroadcastUser) => {
        if (row.id === 'u1') throw new Error('bad ciphertext');
        return row;
      },
    });

    const out = await result;

    expect(out.errors).toEqual(['user u1: could not decrypt PII: bad ciphertext']);
    expect(h.sent).toEqual(['ada@example.com']);
  });
});
