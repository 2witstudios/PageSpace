import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideRecipient,
  findUnreachableUrls,
  isLocalhostUrl,
  LedgerCorruptError,
  listUnsubscribeHeaders,
  loadSentEmails,
  openLedger,
  parseArgs,
  preflight,
  recordSent,
  resolveBaseUrl,
  resolveMarketingBase,
} from '../lib/sdk-launch-broadcast';

const LEDGER = '/tmp/ledger.jsonl';
const tempDirs: string[] = [];

async function withLedger(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-launch-ledger-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'sent.jsonl');
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const alwaysValid = () => true;

function decide(overrides: Partial<Parameters<typeof decideRecipient>[0]> = {}) {
  return decideRecipient({
    email: 'ada@example.com',
    userId: 'u1',
    isValidEmail: alwaysValid,
    alreadySent: new Set(),
    suppressed: new Set(),
    optedOut: new Set(),
    ...overrides,
  }).outcome;
}

describe('parseArgs', () => {
  it('given no flags, should default to a dry run', () => {
    expect(parseArgs([], LEDGER).live).toBe(false);
  });

  it('given --live, should enable the real send', () => {
    expect(parseArgs(['--live'], LEDGER).live).toBe(true);
  });

  it('given both --live and --dry-run, should refuse rather than guess', () => {
    expect(() => parseArgs(['--live', '--dry-run'], LEDGER)).toThrow(/not both/);
  });

  it('given a zero or negative --limit, should reject it', () => {
    expect(() => parseArgs(['--limit=0'], LEDGER)).toThrow(/Invalid --limit/);
    expect(() => parseArgs(['--limit=-5'], LEDGER)).toThrow(/Invalid --limit/);
  });

  it('given an unknown flag, should reject it rather than silently ignore it', () => {
    expect(() => parseArgs(['--send-it'], LEDGER)).toThrow(/Unknown argument/);
  });

  it('given valid flags, should parse them', () => {
    const opts = parseArgs(['--live', '--include-unverified', '--limit=25', '--delay-ms=0'], LEDGER);
    expect(opts).toMatchObject({ live: true, includeUnverified: true, limit: 25, delayMs: 0 });
  });

  it('given no flags, should exclude unverified addresses', () => {
    // An unverified address was never proven to belong to the account holder.
    // Mailing it is mailing a stranger, so opting in must be deliberate.
    expect(parseArgs([], LEDGER).includeUnverified).toBe(false);
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
  // The email's CTA points at docs pages that ship in a sibling PR. Mailing
  // everyone a 404 is not something you can take back.
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

describe('loadSentEmails', () => {
  it('given no ledger yet, should start from an empty set', async () => {
    expect(await loadSentEmails(path.join(os.tmpdir(), 'definitely-absent.jsonl'))).toEqual(new Set());
  });

  it('given recorded sends, should normalize the addresses it returns', async () => {
    const file = await withLedger(
      '{"email":"Ada@Example.com","userId":"u1","sentAt":"2026-07-14T00:00:00.000Z"}\n' +
        '{"email":"grace@example.com","userId":"u2","sentAt":"2026-07-14T00:00:01.000Z"}\n',
    );
    expect(await loadSentEmails(file)).toEqual(new Set(['ada@example.com', 'grace@example.com']));
  });

  it('given a torn final line from an interrupted run, should refuse to run rather than risk a double-send', async () => {
    const file = await withLedger(
      '{"email":"ada@example.com","userId":"u1","sentAt":"2026-07-14T00:00:00.000Z"}\n{"email":"grace@exa',
    );
    await expect(loadSentEmails(file)).rejects.toBeInstanceOf(LedgerCorruptError);
  });

  it('given a line with no email, should refuse to run — it may record someone already mailed', async () => {
    const file = await withLedger('{"userId":"u1","sentAt":"2026-07-14T00:00:00.000Z"}\n');
    await expect(loadSentEmails(file)).rejects.toThrow(/missing "email"/);
  });

  it('given blank lines, should tolerate them', async () => {
    const file = await withLedger('\n{"email":"ada@example.com","userId":"u1","sentAt":"x"}\n\n');
    expect(await loadSentEmails(file)).toEqual(new Set(['ada@example.com']));
  });
});

describe('recordSent', () => {
  it('given a send, should append a line that a later run reads back as already-sent', async () => {
    const file = await withLedger('');
    const handle = await openLedger(file);
    await recordSent(handle, { email: 'ada@example.com', userId: 'u1', sentAt: '2026-07-14T00:00:00.000Z' });
    await handle.close();

    expect(await loadSentEmails(file)).toEqual(new Set(['ada@example.com']));
  });
});

describe('decideRecipient', () => {
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
    // exclude anyone in that case, which is exactly why the script refuses to go
    // live before it ever gets here (see the listSuppressedEmails() === null
    // branch in send-sdk-launch-notifications.ts). Pinned so nobody "fixes" the
    // null case here and assumes the broadcast is now safe without that guard.
    expect(decide({ suppressed: null })).toBe('send');
  });
});
