import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConsumerSpendView } from '@pagespace/lib/billing/wallet-views';
import { WalletSpendCard } from '../drive-wallet/WalletSpendCard';

const rows: ConsumerSpendView[] = [
  { kind: 'member', consumerKey: 'user:u-priya', userId: 'u-priya', displayName: 'Priya Nair', spentCents: 2_000, spentCredits: '20' },
  { kind: 'automation', consumerKey: 'automation:wf-digest', automationWorkflowId: 'wf-digest', displayName: 'Weekly digest', creatorUserId: 'u-priya', creatorName: 'Priya Nair', spentCents: 1_500, spentCredits: '15' },
  { kind: 'automation', consumerKey: 'automation:wf-gone', automationWorkflowId: 'wf-gone', displayName: null, creatorUserId: null, creatorName: null, spentCents: 300, spentCredits: '3' },
];

describe('WalletSpendCard', () => {
  it("SPEND-10 (partial) lists spend by member and by automation: a creator's workflow is its own row, named, saying who it runs as", () => {
    render(<WalletSpendCard rows={rows} spentCredits="38" />);
    const items = screen.getAllByTestId('wallet-spend-row').map((li) => li.textContent);
    expect(items).toEqual([
      'Priya Nair20 credits',
      'Weekly digestAutomation · runs as Priya Nair15 credits',
      'Deleted automationAutomation3 credits',
    ]);
    expect(screen.getByTestId('wallet-spend-card').textContent).toContain('38 credits across 1 person and 2 automations.');
  });

  it('with no automation spend it counts people only', () => {
    render(<WalletSpendCard rows={[rows[0]]} spentCredits="20" />);
    expect(screen.getByTestId('wallet-spend-card').textContent).toContain('20 credits across 1 person.');
  });
});
