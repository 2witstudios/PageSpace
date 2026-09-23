/**
 * Drift guard for the wallet vocabularies inlined in `operations/wallets.ts` (the published
 * SDK never runtime- or type-imports `@pagespace/lib`). Same pattern as
 * `roles-pageperm-drift-guard.test.ts`: test-only TYPE imports from lib's exported subpaths,
 * checked at compile time by `AssertExact` (the SDK's `typecheck` fails on drift).
 *
 * `ConsumerWalletView` and `MyWallets` live in lib modules with no `exports` entry
 * (`billing/wallet-views`, `services/drive-wallet-service`), so they cannot be type-imported
 * here; the consumer view's KEY SET is instead pinned against the `CONSUMER_WALLET_FIELDS`
 * allowlist read from lib's source file.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CallSpendDecision as LibCallSpendDecision } from '@pagespace/lib/billing/spend-target';
import type { SpendSourceKind as LibSpendSourceKind, WalletStatus as LibWalletStatus } from '@pagespace/lib/billing/wallet-core';
import { CONSUMER_WALLET_VIEW_KEYS, type CallSpendDecision, type ConsumerWalletView } from '../wallets.js';

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const decisionIdentical: AssertExact<CallSpendDecision, LibCallSpendDecision> = true;
const sourceIdentical: AssertExact<ConsumerWalletView['defaultSpendSource'], LibSpendSourceKind | null> = true;
const statusIdentical: AssertExact<ConsumerWalletView['status'], LibWalletStatus> = true;

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_VIEWS_SOURCE = resolve(__dirname, '../../../../lib/src/billing/wallet-views.ts');

function libConsumerWalletFields(): string[] {
  const source = readFileSync(WALLET_VIEWS_SOURCE, 'utf-8');
  const match = /export const CONSUMER_WALLET_FIELDS = \[([^\]]*)\] as const;/.exec(source);
  if (!match) throw new Error('CONSUMER_WALLET_FIELDS not found in lib wallet-views.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('operations/wallets.ts — drift guard vs @pagespace/lib canonical shapes', () => {
  it('X-1 (partial) CallSpendDecision, SpendSourceKind and WalletStatus match lib (enforced at compile time above)', () => {
    expect([decisionIdentical, sourceIdentical, statusIdentical]).toEqual([true, true, true]);
  });

  it("X-1 (partial) the consumer view's keys are exactly lib's CONSUMER_WALLET_FIELDS allowlist", () => {
    const libFields = libConsumerWalletFields();
    expect(libFields.length).toBeGreaterThan(0);
    expect([...CONSUMER_WALLET_VIEW_KEYS].sort()).toEqual([...libFields].sort());
  });
});
