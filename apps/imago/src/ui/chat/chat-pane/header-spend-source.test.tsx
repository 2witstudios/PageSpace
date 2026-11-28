// @vitest-environment jsdom
import '@/retained/test/setup';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSpendContextStore } from '@/retained/stores/useSpendContextStore';
const api = vi.hoisted(() => ({ choose: vi.fn(), read: vi.fn(), unresolved: false }));
const options = [{ source: 'drive_wallet' as const, walletId: 'wallet', label: 'Product wallet', driveName: 'Product', orgName: 'Northwind', remainingCents: 900, remainingCredits: '900' }, { source: 'own_credits' as const, walletId: 'own', label: 'Your credits', driveName: null, orgName: null, remainingCents: 100, remainingCredits: '100' }];
vi.mock('@/retained/hooks/useConversationSpend', () => ({ useConversationSpend: (conversationId: string | null, scope: unknown) => { api.read(conversationId, scope); return { spend: api.unresolved ? null : { conversationId, chosenWalletId: null, options, resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'wallet', fallbackApplied: false, fallbackFrom: null } }, choose: api.choose, isPending: api.unresolved }; }, useDriveSpend: (driveId: string | null) => ({ spend: driveId ? { options, resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'wallet' } } : null }) }));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: React.ReactNode }) => children }));
import { HeaderSpendSource } from './header-spend-source';
beforeEach(() => { api.read.mockClear(); api.unresolved = false; useSpendContextStore.setState({ entries: [], active: null }); });
it('names the actual wallet in a compact icon and credit-count header chip', () => {
  useSpendContextStore.getState().register('focused', { conversationId: 'c-other', driveId: 'd-other', isGlobal: false });
  render(<HeaderSpendSource agentId="agent-route" conversationId="c-route" />);
  const chip = screen.getByTestId('spend-source-chip');
  expect(chip.getAttribute('aria-label')).toBe('Spending from Product wallet: 900 credits');
  expect(chip.textContent).toBe('900 credits');
  expect(api.read).toHaveBeenCalledWith('c-other', { driveId: 'd-other', isGlobal: false });
});

it('withholds an invalidated conversation source instead of substituting a drive preview', () => {
  api.unresolved = true;
  useSpendContextStore.getState().register('focused', { conversationId: 'c-other', driveId: 'd-other', isGlobal: false });
  render(<HeaderSpendSource agentId="agent-route" conversationId="c-route" />);
  expect(screen.queryByTestId('spend-source-chip')).toBeNull();
});
