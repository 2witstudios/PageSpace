// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { SpendStrip } from './spend-strip';
const state = vi.hoisted(() => ({ apiFetch: vi.fn(async () => ({})), mutate: vi.fn() }));
vi.mock('swr', () => ({ default: () => ({}), useSWRConfig: () => ({ mutate: state.mutate }) }));
vi.mock('@/api/swr-provider', () => ({ useApiClient: () => ({ apiFetch: state.apiFetch }) }));
vi.mock('@/realtime/realtime-provider', () => ({ useSocketEvent: () => {} }));
vi.mock('@/retained/hooks/useConversationSpend', () => ({
  conversationSpendKey: (id: string) => `/api/wallets/conversations/${id}`,
  useConversationSpend: () => ({ spend: null, choose: vi.fn() }),
  useDriveSpend: () => ({ spend: { driveId: 'd1', options: [
    { source: 'drive_wallet', walletId: 'drive', label: 'Design wallet', remainingCredits: '100', driveName: 'Design', orgName: 'Team' },
    { source: 'own_credits', walletId: 'own', label: 'Your credits', remainingCredits: '50', driveName: null, orgName: null },
  ], resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'drive', fallbackApplied: false, fallbackFrom: null } } }),
}));
vi.mock('@/retained/components/ui/popover', () => ({ Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>, PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>, PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/retained/components/wallets/SpendSourcePopover', () => ({ SpendSourceOptionsPanel: ({ onChoose }: { onChoose?: (id: string) => Promise<void> }) => <button onClick={() => void onChoose?.('own')}>Use personal source</button> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
test('choosing on an agent draft delegates only the selected wallet to its owning surface', async () => {
  const chooseDraft = vi.fn(async (_walletId: string) => {});
  render(<SpendStrip driveId="d1" onChooseDraftSource={chooseDraft} />);
  fireEvent.click(screen.getByText('Use personal source'));
  await waitFor(() => expect(chooseDraft).toHaveBeenCalledWith('own'));
  expect(chooseDraft).toHaveBeenCalledOnce();
  expect(state.apiFetch).not.toHaveBeenCalled();
});
