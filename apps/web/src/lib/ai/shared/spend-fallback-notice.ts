/**
 * The line a chat shows when a drive's fallback rule moved a call to another source
 * (SPEND-4: the gate never switches silently). The payload is the turn's
 * `data-spend-fallback` part, which crosses the wire untyped, so it is validated here; a
 * malformed payload renders nothing.
 */

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  drive_wallet: 'the drive wallet',
  seat_allowance: 'your seat allowance',
  own_credits: 'your own credits',
};

function labelOf(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(SOURCE_LABELS, value) ? SOURCE_LABELS[value] : null;
}

export function spendFallbackNoticeText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const from = labelOf(record.from);
  const to = labelOf(record.to);
  if (from === null || to === null || record.from === record.to) return null;
  return `Spent from ${to} — ${from} couldn't cover this call.`;
}
