import { describe, it, expect } from 'vitest';
import { spendFallbackNoticeText } from '../spend-fallback-notice';

describe('the spend fallback notice (SPEND-4)', () => {
  it.each([
    [{ from: 'drive_wallet', to: 'own_credits' }, "Spent from your own credits — the drive wallet couldn't cover this call."],
    [{ from: 'drive_wallet', to: 'seat_allowance' }, "Spent from your seat allowance — the drive wallet couldn't cover this call."],
    [{ from: 'seat_allowance', to: 'own_credits' }, "Spent from your own credits — your seat allowance couldn't cover this call."],
  ])('SPEND-4 (partial) names the source the call moved TO and the one it moved FROM: %o', (data, text) => {
    expect(spendFallbackNoticeText(data)).toBe(text);
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'drive_wallet'],
    ['an unknown source', { from: 'drive_wallet', to: 'someone_elses_wallet' }],
    ['a missing from', { to: 'own_credits' }],
    ['no move at all', { from: 'own_credits', to: 'own_credits' }],
  ])('SPEND-4 (partial) a malformed payload renders nothing: %s', (_label, data) => {
    expect(spendFallbackNoticeText(data)).toBeNull();
  });
});
