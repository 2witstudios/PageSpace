import { describe, it, expect, vi } from 'vitest';
import {
  decideRecipient,
  findUnreachableUrls,
  isLocalhostUrl,
  LedgerWriteFailed,
  listUnsubscribeHeaders,
  preflight,
  resolveBaseUrl,
  resolveMarketingBase,
  runBroadcast,
  type BroadcastUser,
  type SentLedgerEntry,
} from '../core';

/**
 * The send loop is the code that can email someone twice, or email someone we
 * were told never to email. These tests exercise it with the database and the
 * mail provider replaced by spies, so the orderings it depends on are pinned.
 *
 * Moved here from scripts/__tests__ when the pure core was promoted into the library:
 * the guards now bind the admin-console broadcast worker as well as the launch script,
 * so they are tested where they live.
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
    rightsRestricted: new Set(),
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
  it('should never mail a suppressed, opted-out, rights-restricted, already-sent, or invalid address', async () => {
    const { result, h } = run(
      [
        user('u1', 'erased@example.com'),
        user('u2', 'optedout@example.com'),
        user('u3', 'done@example.com'),
        user('u4', 'not-an-email'),
        user('u5', 'pending-erasure@example.com'),
        user('u6', 'ada@example.com'),
      ],
      {
        suppressed: new Set(['erased@example.com']),
        optedOut: new Set(['u2']),
        alreadySent: new Set(['done@example.com']),
        rightsRestricted: new Set(['u5']),
      },
    );

    const out = await result;

    expect(h.sent).toEqual(['ada@example.com']);
    expect(out.skipped).toEqual({
      suppressed: 1,
      'opted-out': 1,
      'already-sent': 1,
      'invalid-email': 1,
      'rights-restricted': 1,
    });
  });
});

describe('runBroadcast — limit', () => {
  it('should count ATTEMPTS, not successes, so an outage cannot walk the whole audience', async () => {
    // A limit=2 canary where every send fails must still stop after 2 attempts.
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
    // Suppressed/already-sent rows are not attempts; a limit=1 run should still
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

describe('runBroadcast — durable observers', () => {
  // The durable (admin-console) path needs to persist WHY someone was skipped and how a
  // send failed, per recipient. The file-ledger script only ever counted them, so these
  // hooks are optional — but when supplied they must fire for every such row.

  it('given onSkip, should report every declined recipient with its reason', async () => {
    const skips: Array<{ userId: string; reason: string }> = [];
    const { result } = run(
      [user('u1', 'erased@example.com'), user('u2', 'optedout@example.com'), user('u3', 'ada@example.com')],
      {
        suppressed: new Set(['erased@example.com']),
        optedOut: new Set(['u2']),
        onSkip: async ({ userId, reason }) => {
          skips.push({ userId, reason });
        },
      },
    );

    await result;

    expect(skips).toEqual([
      { userId: 'u1', reason: 'suppressed' },
      { userId: 'u2', reason: 'opted-out' },
    ]);
  });

  it('given onFailure, should report the failed send and still not record it as sent', async () => {
    const failures: Array<{ userId: string; error: string }> = [];
    const { result, h } = run([user('u1', 'ada@example.com')], {
      sendOne: vi.fn(async () => {
        throw new Error('rate limited');
      }),
      onFailure: async ({ userId, error }) => {
        failures.push({ userId, error });
      },
    });

    await result;

    expect(failures).toEqual([{ userId: 'u1', error: 'rate limited' }]);
    // The recipient must stay retryable: a failure is never a ledger entry.
    expect(h.recorded).toEqual([]);
  });

  it('given a dry run, should not report failures — nothing was attempted against a provider', async () => {
    const failures: unknown[] = [];
    const { result } = run([user('u1', 'ada@example.com')], {
      live: false,
      onFailure: async (f) => {
        failures.push(f);
      },
    });

    await result;

    expect(failures).toEqual([]);
  });
});

describe('runBroadcast — claiming recipients', () => {
  // The in-memory `alreadySent` set only speaks for one process. Two workers (overlapping
  // retries, or two instances) can both pass every decision check and both mail the same
  // person — the ledger's unique constraint would then coalesce two rows that represent
  // two emails already sent. A durable caller decides ownership in the DB via `claim`.

  it('should claim a recipient BEFORE handing them to the provider', async () => {
    // Ordering is the entire point: a claim after the send would coalesce the record of a
    // duplicate rather than prevent it.
    const order: string[] = [];
    const { result } = run([user('u1', 'ada@example.com')], {
      claim: async () => {
        order.push('claim');
        return true;
      },
      sendOne: vi.fn(async () => {
        order.push('send');
      }),
      record: vi.fn(async () => {
        order.push('record');
      }),
    });
    await result;

    expect(order).toEqual(['claim', 'send', 'record']);
  });

  it('given a recipient another worker owns, should not mail them', async () => {
    const { result, h } = run([user('u1', 'ada@example.com'), user('u2', 'grace@example.com')], {
      claim: async ({ email }) => email !== 'ada@example.com',
    });

    const out = await result;

    expect(h.sent).toEqual(['grace@example.com']);
    expect(out.claimedElsewhere).toBe(1);
  });

  it('should not count a lost claim as a skip — the other worker is mailing them', async () => {
    // Counting it would double-count the person across the two workers' records.
    const { result } = run([user('u1', 'ada@example.com')], { claim: async () => false });

    const out = await result;

    expect(out.skipped).toEqual({
      'already-sent': 0,
      suppressed: 0,
      'opted-out': 0,
      'rights-restricted': 0,
      'invalid-email': 0,
    });
    expect(out.claimedElsewhere).toBe(1);
  });

  it('should not let a lost claim consume the canary budget', async () => {
    // A limit=1 canary must still reach a recipient we actually own.
    const { result, h } = run(
      [user('u1', 'taken.example.com'), user('u2', 'also-taken@example.com'), user('u3', 'ada@example.com')],
      { limit: 1, claim: async ({ email }) => email === 'ada@example.com' },
    );

    const out = await result;

    expect(h.sent).toEqual(['ada@example.com']);
    expect(out.attempted).toBe(1);
  });

  it('given the claim itself throws, should fail CLOSED and not send', async () => {
    // An unreadable claim means we cannot prove nobody else is mailing this person, and
    // the irreversible mistake is sending, not skipping.
    const { result, h } = run([user('u1', 'ada@example.com')], {
      claim: async () => {
        throw new Error('db down');
      },
    });

    const out = await result;

    expect(h.sent).toEqual([]);
    expect(out.errors).toEqual(['ada@example.com: could not claim recipient: db down']);
  });

  it('given a dry run, should claim nothing — a preview must not write', async () => {
    const claim = vi.fn(async () => true);
    const { result } = run([user('u1', 'ada@example.com')], { live: false, claim });

    await result;

    expect(claim).not.toHaveBeenCalled();
  });

  it('given no claim hook, should behave exactly as before for the single-process script', async () => {
    const { result, h } = run([user('u1', 'ada@example.com')]);

    const out = await result;

    expect(h.sent).toEqual(['ada@example.com']);
    expect(out.claimedElsewhere).toBe(0);
  });
});

describe('preflight', () => {
  const base = {
    live: true,
    baseUrl: 'https://app.pagespace.ai',
    suppressed: new Set<string>(),
    isOnPrem: false,
    fromEmail: 'PageSpace <hello@pagespace.ai>',
  };

  it('given a well-configured live send, should allow it', () => {
    expect(preflight(base)).toEqual({ ok: true });
  });

  it('given a localhost app URL, should refuse the live send', () => {
    // Otherwise every recipient gets an unsubscribe link they cannot use.
    const result = preflight({ ...base, baseUrl: 'http://localhost:3000' });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringMatching(/localhost/) });
  });

  it('given an unreadable suppression audience, should refuse the live send', () => {
    // We cannot prove GDPR-erased users are excluded, so we do not send at all.
    const result = preflight({ ...base, suppressed: null });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringMatching(/erased users cannot be/) });
  });

  it('given on-prem mode, should refuse the live send', () => {
    // sendEmail() silently drops mail on-prem: the run would send nothing while
    // recording every recipient as already-sent, poisoning the ledger.
    const result = preflight({ ...base, isOnPrem: true });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringMatching(/on-prem/) });
  });

  it('given no FROM_EMAIL, should refuse the live send', () => {
    // Otherwise every send falls back to Resend's sandbox address and fails.
    const result = preflight({ ...base, fromEmail: undefined });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringMatching(/FROM_EMAIL/) });
  });

  it('given no postal address, should STILL allow the live send', () => {
    // A DELIBERATE, owner-accepted tradeoff, not an oversight: CAN-SPAM wants a physical
    // address on commercial mail, and the alternative on offer was publishing a home
    // address. The launch shipped this way on purpose. Pinned so nobody "fixes" it into a
    // hard block without that decision being revisited — set COMPANY_POSTAL_ADDRESS to
    // include one. (`preflight` takes no postal address at all; this asserts the absence
    // of a guard, which is the only way an absent guard can be pinned.)
    expect(preflight({ ...base })).toEqual({ ok: true });
  });

  it('given a dry run, should allow every otherwise-unsafe configuration', () => {
    expect(
      preflight({
        live: false,
        baseUrl: 'http://localhost:3000',
        suppressed: null,
        isOnPrem: true,
        fromEmail: undefined,
      }),
    ).toEqual({ ok: true });
  });
});

describe('findUnreachableUrls', () => {
  // A CTA that 404s reaches the whole audience at once and cannot be taken back.
  const ok = () => Promise.resolve({ ok: true, status: 200 } as Response);

  it('given reachable pages, should report nothing', async () => {
    const fetchImpl = vi.fn(ok);
    expect(await findUnreachableUrls(['https://x/a', 'https://x/b'], fetchImpl)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith('https://x/a', { method: 'HEAD', redirect: 'follow' });
  });

  it('given a page that 404s, should report it', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/cli')
        ? ({ ok: false, status: 404 } as Response)
        : ({ ok: true, status: 200 } as Response),
    );

    const unreachable = await findUnreachableUrls(['https://x/sdk', 'https://x/cli'], fetchImpl);

    expect(unreachable).toEqual(['https://x/cli (HTTP 404)']);
  });

  it('given a network failure, should report it rather than assume the page is fine', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('DNS go boom');
    });

    const unreachable = await findUnreachableUrls(['https://x/sdk'], fetchImpl);

    expect(unreachable).toEqual(['https://x/sdk (DNS go boom)']);
  });
});

describe('listUnsubscribeHeaders', () => {
  it('should advertise RFC 8058 one-click unsubscribe pointing at the recipient token', () => {
    // Gmail/Yahoo bulk rules require these headers; a body link alone is not enough.
    expect(listUnsubscribeHeaders('https://app.pagespace.ai/api/notifications/unsubscribe/tok')).toEqual({
      'List-Unsubscribe': '<https://app.pagespace.ai/api/notifications/unsubscribe/tok>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

describe('isLocalhostUrl', () => {
  it('given a local address, should report it as localhost', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1', 'http://0.0.0.0:80', 'http://[::1]']) {
      expect(isLocalhostUrl(url)).toBe(true);
    }
  });

  it('given a public URL, should not report it as localhost', () => {
    expect(isLocalhostUrl('https://app.pagespace.ai')).toBe(false);
  });

  it('given an unparseable URL, should fail closed and call it unsafe', () => {
    expect(isLocalhostUrl('not a url')).toBe(true);
  });
});

describe('resolveBaseUrl', () => {
  it('given a stale localhost NEXT_PUBLIC_APP_URL, should prefer the public WEB_APP_URL', () => {
    const url = resolveBaseUrl({
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      WEB_APP_URL: 'https://app.pagespace.ai',
    } as NodeJS.ProcessEnv);
    expect(url).toBe('https://app.pagespace.ai');
  });

  it('given a trailing slash, should strip it so paths concatenate cleanly', () => {
    const url = resolveBaseUrl({ WEB_APP_URL: 'https://app.pagespace.ai/' } as NodeJS.ProcessEnv);
    expect(url).toBe('https://app.pagespace.ai');
  });
});

describe('resolveMarketingBase', () => {
  it('given no configuration, should fall back to the public site', () => {
    expect(resolveMarketingBase({} as NodeJS.ProcessEnv)).toBe('https://pagespace.ai');
  });

  it('given a URL with a stray path, should keep only the origin', () => {
    const base = resolveMarketingBase({ MARKETING_BASE_URL: 'https://pagespace.ai/blog/' } as NodeJS.ProcessEnv);
    expect(base).toBe('https://pagespace.ai');
  });

  it('given a malformed or non-http URL, should fall back rather than emit a broken link', () => {
    expect(resolveMarketingBase({ MARKETING_BASE_URL: 'javascript:alert(1)' } as NodeJS.ProcessEnv)).toBe(
      'https://pagespace.ai',
    );
    expect(resolveMarketingBase({ MARKETING_BASE_URL: 'pagespace.ai' } as NodeJS.ProcessEnv)).toBe(
      'https://pagespace.ai',
    );
  });
});

describe('decideRecipient', () => {
  const alwaysValid = () => true;

  function decide(overrides: Partial<Parameters<typeof decideRecipient>[0]> = {}) {
    return decideRecipient({
      email: 'ada@example.com',
      userId: 'u1',
      isValidEmail: alwaysValid,
      alreadySent: new Set(),
      suppressed: new Set(),
      optedOut: new Set(),
      rightsRestricted: new Set(),
      ...overrides,
    }).outcome;
  }

  it('given a fresh valid recipient, should send', () => {
    expect(decide()).toBe('send');
  });

  it('given a send, should hand back the trimmed address and its normalized ledger key', () => {
    const decision = decideRecipient({
      email: '  Ada@Example.com  ',
      userId: 'u1',
      isValidEmail: alwaysValid,
      alreadySent: new Set(),
      suppressed: new Set(),
      optedOut: new Set(),
      rightsRestricted: new Set(),
    });

    expect(decision).toEqual({
      outcome: 'send',
      email: 'Ada@Example.com',
      emailKey: 'ada@example.com',
    });
  });

  it('given an address in the erasure-suppression audience, should skip it', () => {
    expect(decide({ suppressed: new Set(['ada@example.com']) })).toBe('suppressed');
  });

  it('given a differently-cased suppressed address, should still skip it', () => {
    expect(decide({ email: 'ADA@Example.com', suppressed: new Set(['ada@example.com']) })).toBe('suppressed');
  });

  it('given a user who opted out of product updates, should skip them', () => {
    expect(decide({ optedOut: new Set(['u1']) })).toBe('opted-out');
  });

  it('given a user with a pending or blocked GDPR erasure, should skip them', () => {
    // The Resend suppression audience only holds erasures that already RAN. An
    // erasure that is queued or blocked leaves a completely normal-looking user
    // row — and mailing that person is the exact harm they asked us to prevent.
    expect(decide({ rightsRestricted: new Set(['u1']) })).toBe('rights-restricted');
  });

  it('should skip a rights-restricted user even when they are not in the suppression list', () => {
    expect(decide({ rightsRestricted: new Set(['u1']), suppressed: new Set() })).toBe(
      'rights-restricted',
    );
  });

  it('given an address already in the ledger, should skip it', () => {
    expect(decide({ alreadySent: new Set(['ada@example.com']) })).toBe('already-sent');
  });

  it('given a missing or invalid address, should skip it', () => {
    expect(decide({ email: null })).toBe('invalid-email');
    expect(decide({ email: '   ' })).toBe('invalid-email');
    expect(decide({ email: 'nope', isValidEmail: () => false })).toBe('invalid-email');
  });

  it('given an unreadable suppression list, should still return send — the live-send guard is upstream', () => {
    // `null` means "we could not read the audience". This function has no way to
    // exclude anyone in that case, which is exactly why callers refuse to go live
    // before they ever get here (see the suppressed === null branch in preflight).
    // Pinned so nobody "fixes" the null case here and assumes the broadcast is now
    // safe without that guard.
    expect(decide({ suppressed: null })).toBe('send');
  });
});