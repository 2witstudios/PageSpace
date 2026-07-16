import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LedgerCorruptError,
  loadSentEmails,
  openLedger,
  parseArgs,
  recordSent,
} from '../lib/sdk-launch-broadcast';

/**
 * The launch script's own surface: CLI flags and the JSONL ledger.
 *
 * The decision logic these used to sit beside (the send loop, the preflight guards,
 * decideRecipient, URL resolution) moved to `@pagespace/lib/services/broadcast/core` and
 * is tested there — packages/lib/src/services/broadcast/__tests__/core.test.ts. What
 * remains here is what is genuinely specific to running this script from a laptop against
 * a local file. See the re-export contract test in send-sdk-launch-broadcast-loop.test.ts
 * for the seam that keeps the script importing those functions from one place.
 */

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