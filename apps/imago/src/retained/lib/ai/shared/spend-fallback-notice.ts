import { spendFallbackCopy } from '@pagespace/lib/billing/spend-surface';

/**
 * The line a chat shows when a drive's fallback rule moved a call to another source
 * (SPEND-4: the gate never switches silently). The payload is the turn's
 * `data-spend-fallback` part, which crosses the wire untyped, so it is validated (by the one
 * copy function, lib spend-surface); a malformed payload renders nothing. `fromLabel` names the
 * wallet it moved off when the conversation's options know it ("Product wallet").
 */
export function spendFallbackNoticeText(data: unknown, fromLabel: string | null = null): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  // The payload says what moved, not why: the wallet's status now may not be its status then.
  return spendFallbackCopy({ from: record.from, to: record.to, fromLabel, fromStatus: null });
}
