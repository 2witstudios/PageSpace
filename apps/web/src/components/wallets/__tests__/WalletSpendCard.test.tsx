import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConsumerSpendView } from '@pagespace/lib/billing/wallet-views';
import { WalletSpendCard } from '../drive-wallet/WalletSpendCard';

const priya: ConsumerSpendView = {
  consumerKey: 'user:u-priya', userId: 'u-priya', displayName: 'Priya Nair',
  spentCents: 3_800, spentCredits: '38', spentTodayCents: 500, spentTodayCredits: '5', viaAutomationsCents: 1_800, viaAutomationsCredits: '18',
  automations: [
    { consumerKey: 'automation:workflow:wf-digest', automation: { kind: 'workflow', workflowId: 'wf-digest' }, displayName: 'Weekly digest', creatorUserId: 'u-priya', creatorName: 'Priya Nair', spentCents: 1_500, spentCredits: '15', spentTodayCents: 0, spentTodayCredits: '0' },
    { consumerKey: 'automation:workflow:wf-gone', automation: { kind: 'workflow', workflowId: 'wf-gone' }, displayName: null, creatorUserId: null, creatorName: null, spentCents: 300, spentCredits: '3', spentTodayCents: 0, spentTodayCredits: '0' },
  ],
};
const former: ConsumerSpendView = {
  consumerKey: 'former-member', userId: null, displayName: null,
  spentCents: 200, spentCredits: '2', spentTodayCents: 0, spentTodayCredits: '0', viaAutomationsCents: 0, viaAutomationsCredits: '0', automations: [],
};

describe('WalletSpendCard', () => {
  it("SPEND-10 (partial) UI-9 (partial) lists spend by member, with a creator's workflows nested under them as named rows saying who they run as (D-OW-67)", () => {
    render(<WalletSpendCard rows={[priya, former]} spentCredits="40" />);
    const items = screen.getAllByTestId('wallet-spend-row');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Priya Nair');
    expect(items[1].textContent).toBe('Former member0 today · 0 via automations2 credits');
    expect(screen.getAllByTestId('wallet-spend-split')[0].textContent).toBe('5 today · 18 via automations');
    expect(screen.getAllByTestId('wallet-spend-automation-row').map((li) => li.textContent)).toEqual([
      'Weekly digestAutomation · runs as Priya Nair15 credits',
      'Deleted automationAutomation3 credits',
    ]);
    expect(screen.getByTestId('wallet-spend-card').textContent).toContain('40 credits across 2 people and 2 automations.');
  });

  it('with no automation spend it counts people only', () => {
    render(<WalletSpendCard rows={[former]} spentCredits="2" />);
    expect(screen.getByTestId('wallet-spend-card').textContent).toContain('2 credits across 1 person.');
    expect(screen.queryByTestId('wallet-spend-automation-row')).toBeNull();
  });
});
