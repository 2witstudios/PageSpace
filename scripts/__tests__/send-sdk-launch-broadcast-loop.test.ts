import { describe, it, expect, vi } from 'vitest';
import * as barrel from '../lib/sdk-launch-broadcast';
import * as core from '@pagespace/lib/services/broadcast/core';

/**
 * The seam that keeps the launch script working after the send loop moved out.
 *
 * `scripts/send-sdk-launch-notifications.ts` imports every one of these from
 * `./lib/sdk-launch-broadcast`, unchanged, while the functions themselves now live in
 * `@pagespace/lib/services/broadcast/core` (and are exercised in depth by
 * packages/lib/src/services/broadcast/__tests__/core.test.ts — the loop's behaviour is
 * pinned there, not duplicated here).
 *
 * What this file pins is the RE-EXPORT: that the script reaches the real implementation
 * and not a stale copy left behind in scripts/lib. A broadcast running against a divergent
 * fork of the guards is precisely the failure the promotion was meant to end, and an
 * identity check is the cheapest way to notice it.
 */

describe('sdk-launch-broadcast re-export contract', () => {
  it.each([
    'runBroadcast',
    'decideRecipient',
    'preflight',
    'findUnreachableUrls',
    'isLocalhostUrl',
    'listUnsubscribeHeaders',
    'resolveBaseUrl',
    'resolveMarketingBase',
    'LedgerWriteFailed',
  ] as const)('should re-export the library\'s %s, not a local fork', (name) => {
    expect(barrel[name]).toBe(core[name]);
  });

  it('should keep the fs-only ledger pieces local — they are the script\'s own', () => {
    // These deliberately did NOT move: the durable path records to broadcast_recipients
    // instead of a JSONL file, so the library must not grow a filesystem dependency.
    for (const name of ['parseArgs', 'loadSentEmails', 'openLedger', 'recordSent', 'LedgerCorruptError']) {
      expect(barrel).toHaveProperty(name);
      expect(core).not.toHaveProperty(name);
    }
  });

  it('should drive a send end-to-end through the re-exported loop', async () => {
    // A smoke test through the barrel: the script's exact import path reaches a working
    // loop, not just a matching identity.
    const sent: string[] = [];
    const recorded: string[] = [];

    const result = await barrel.runBroadcast({
      live: true,
      limit: null,
      delayMs: 0,
      rows: [{ id: 'u1', email: 'ada@example.com', name: 'Ada' }],
      decrypt: async (row) => row,
      isValidEmail: (email) => email.includes('@'),
      alreadySent: new Set(),
      suppressed: new Set(),
      optedOut: new Set(),
      rightsRestricted: new Set(),
      sendOne: vi.fn(async ({ email }: { email: string }) => {
        sent.push(email);
      }),
      renderOne: async () => '<html/>',
      record: vi.fn(async (entry: barrel.SentLedgerEntry) => {
        recorded.push(entry.email);
      }),
      now: () => '2026-07-14T00:00:00.000Z',
      sleep: async () => {},
      log: () => {},
      logError: () => {},
    });

    expect(result).toMatchObject({ sent: 1, attempted: 1, errors: [] });
    expect(sent).toEqual(['ada@example.com']);
    expect(recorded).toEqual(['ada@example.com']);
  });
});