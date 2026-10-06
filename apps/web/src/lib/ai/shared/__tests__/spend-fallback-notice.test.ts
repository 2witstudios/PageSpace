import { describe, it, expect } from 'vitest';
import { spendFallbackNoticeText } from '../spend-fallback-notice';

describe('the spend fallback notice', () => {
  it.each([
    [{ from: 'drive_wallet', to: 'own_credits' }, "Used your own credits because the drive wallet couldn't cover this."],
    [{ from: 'drive_wallet', to: 'seat_allowance' }, "Used your seat allowance because the drive wallet couldn't cover this."],
    [{ from: 'seat_allowance', to: 'own_credits' }, "Used your own credits because your seat allowance couldn't cover this."],
  ])('SPEND-4 (partial) names the source the call moved TO and the one it moved FROM: %o', (data, text) => {
    expect(spendFallbackNoticeText(data)).toBe(text);
  });

  it('SPEND-4 (partial) names the wallet it moved off by its label when the conversation knows it', () => {
    expect(spendFallbackNoticeText({ from: 'drive_wallet', to: 'seat_allowance' }, 'Product wallet'))
      .toBe("Used your seat allowance because Product wallet couldn't cover this.");
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
