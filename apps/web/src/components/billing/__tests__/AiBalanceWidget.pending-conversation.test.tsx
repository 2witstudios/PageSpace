import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AiBalanceWidget } from '../AiBalanceWidget';
import { useSpendContextStore } from '@/stores/useSpendContextStore';

const state = vi.hoisted(() => ({
  conversation: null as unknown,
  pending: true,
  missingDraft: true,
  driveRead: vi.fn(),
}));
vi.mock('@/lib/dashboard/focus', () => ({ useFocus: () => ({ kind: 'drive', driveId: 'route-drive' }), focusDriveId: () => 'route-drive' }));
vi.mock('@/hooks/useConversationSpend', () => ({
  useConversationSpend: () => ({ spend: state.conversation, isPending: state.pending, isMissingDraft: state.missingDraft, choose: vi.fn() }),
  useDriveSpend: (driveId: string | null) => {
    state.driveRead(driveId);
    return { spend: driveId ? {
      options: [
        { source: 'drive_wallet', walletId: 'w-drive', label: `${driveId} wallet`, driveName: driveId, orgName: 'Northwind', remainingCents: 192, remainingCredits: '192' },
        { source: 'own_credits', walletId: 'w-own', label: 'Your credits', remainingCents: 1_000, remainingCredits: '1,000' },
      ],
      resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'w-drive', fallbackApplied: false, fallbackFrom: null },
    } : null };
  },
}));
vi.mock('@/components/billing/CreditBalance', () => ({ CreditBalance: () => <div data-testid="personal-credit-chip" /> }));

beforeEach(() => {
  state.conversation = null;
  state.pending = true;
  state.missingDraft = true;
  state.driveRead.mockClear();
  useSpendContextStore.setState({ entries: [], active: null });
});

describe('SPEND-2 (partial) fresh local conversations disclose their actual drive before their first message', () => {
  it('UI-8 (partial) shows the drive preview and source options while a fresh local conversation has no stored row', () => {
    useSpendContextStore.getState().register('draft', { conversationId: 'fresh-global', driveId: 'product', isGlobal: true });
    render(<AiBalanceWidget />);
    const chip = screen.getByTestId('spend-source-chip');
    expect(chip.getAttribute('aria-label')).toBe('Spending from product wallet: 192 credits');
    expect(screen.queryByTestId('personal-credit-chip')).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByText('product wallet')).toBeTruthy();
    expect(screen.getByText('Your credits')).toBeTruthy();
  });

  it('previews the mounted conversation\'s session drive rather than a different drive in the route', () => {
    useSpendContextStore.getState().register('draft', { conversationId: 'fresh-page', driveId: 'session-drive', isGlobal: false });
    render(<AiBalanceWidget />);
    expect(state.driveRead).toHaveBeenLastCalledWith('session-drive');
  });

  it('a mounted driveless global conversation still uses personal credits even inside a drive route', () => {
    useSpendContextStore.getState().register('draft', { conversationId: 'fresh-global', driveId: null, isGlobal: true });
    render(<AiBalanceWidget />);
    expect(screen.getByTestId('personal-credit-chip')).toBeTruthy();
    expect(state.driveRead).toHaveBeenLastCalledWith(null);
  });

  it('does not substitute the drive default while an existing conversation\'s chosen source is still loading', () => {
    state.pending = false;
    state.missingDraft = false;
    useSpendContextStore.getState().register('stored', { conversationId: 'stored-global', driveId: 'product', isGlobal: true });
    render(<AiBalanceWidget />);
    expect(screen.queryByTestId('spend-source-chip')).toBeNull();
    expect(screen.queryByTestId('personal-credit-chip')).toBeNull();
    expect(state.driveRead).toHaveBeenLastCalledWith(null);
  });

});

it('does not display a drive default during an existing source revalidation', () => {
  state.pending = true;
  state.missingDraft = false;
  useSpendContextStore.getState().register('stored', { conversationId: 'stored-global', driveId: 'product', isGlobal: true });
  render(<AiBalanceWidget />);
  expect(screen.queryByTestId('spend-source-chip')).toBeNull();
  expect(screen.queryByTestId('personal-credit-chip')).toBeNull();
  expect(state.driveRead).toHaveBeenLastCalledWith(null);
});
