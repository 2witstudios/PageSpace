/**
 * SPEND-4: the gate never switches wallets silently. When a drive's fallback rule moves a call
 * off the source it named, every entry point reports it to its caller in ONE shape:
 *
 *   - the notice `{ from, to, walletId }`: the source chosen, the source held, the wallet held;
 *   - on any HTTP response, the three `X-Spend-Fallback-*` headers below (set on streamed and
 *     JSON responses alike, so a text stream or an OpenAI-shaped body carries it unchanged);
 *   - a JSON body also carries it as `spendFallback` (null when the call spent what it named);
 *   - a chat turn writes it as its `data-spend-fallback` part (turn-credit).
 *
 * Pure: no IO. The gate decides the fallback; this only names how it travels.
 */
import type { SpendSourceKind } from './wallet-core';

/** The gate's fallback (CreditGateResult.fallback): from the source chosen to the one held. */
export interface SpendFallback {
  from: SpendSourceKind;
  to: SpendSourceKind;
}

/** What a caller is told: the fallback and the wallet the call was actually held on. */
export interface SpendFallbackNotice extends SpendFallback {
  walletId: string | null;
}

export const SPEND_FALLBACK_FROM_HEADER = 'X-Spend-Fallback-From';
export const SPEND_FALLBACK_TO_HEADER = 'X-Spend-Fallback-To';
export const SPEND_FALLBACK_WALLET_HEADER = 'X-Spend-Fallback-Wallet';

const SOURCES: readonly SpendSourceKind[] = ['drive_wallet', 'seat_allowance', 'own_credits'];

function isSource(value: string | null): value is SpendSourceKind {
  return value !== null && (SOURCES as readonly string[]).includes(value);
}

/** The notice for a gate answer, or null when it did not fall back (or was refused, or never ran). */
export function spendFallbackNotice(
  gate: { allowed: boolean; walletId?: string; fallback?: SpendFallback } | null | undefined,
): SpendFallbackNotice | null {
  if (!gate || !gate.allowed || !gate.fallback) return null;
  return { from: gate.fallback.from, to: gate.fallback.to, walletId: gate.walletId ?? null };
}

/** The response headers for a notice; none when there was no fallback. */
export function spendFallbackHeaders(notice: SpendFallbackNotice | null): Record<string, string> {
  if (!notice) return {};
  return {
    [SPEND_FALLBACK_FROM_HEADER]: notice.from,
    [SPEND_FALLBACK_TO_HEADER]: notice.to,
    ...(notice.walletId ? { [SPEND_FALLBACK_WALLET_HEADER]: notice.walletId } : {}),
  };
}

/** A client's read of the headers; null unless both name a real source. */
export function readSpendFallbackHeaders(headers: Headers): SpendFallbackNotice | null {
  const from = headers.get(SPEND_FALLBACK_FROM_HEADER);
  const to = headers.get(SPEND_FALLBACK_TO_HEADER);
  if (!isSource(from) || !isSource(to)) return null;
  return { from, to, walletId: headers.get(SPEND_FALLBACK_WALLET_HEADER) };
}

/** A client's read of a JSON body's `spendFallback` (or any value in that shape); null unless it names real sources. */
export function readSpendFallbackBody(value: unknown): SpendFallbackNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { from, to, walletId } = value as Record<string, unknown>;
  if (typeof from !== 'string' || typeof to !== 'string' || !isSource(from) || !isSource(to)) return null;
  return { from, to, walletId: typeof walletId === 'string' ? walletId : null };
}
