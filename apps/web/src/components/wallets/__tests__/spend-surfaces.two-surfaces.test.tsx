/**
 * Review #2835 P1-1: with two chat surfaces mounted (a page chat and the right-sidebar chat, or two
 * agent panes), every spend control writes to the conversation of the surface that rendered it,
 * and the header chip writes to the conversation it shows (the one focused last). The REAL
 * useConversationSpend runs here, so what is asserted is the PUT URL itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/billing/CreditBalance', () => ({ CreditBalance: () => <div data-testid="personal-credit-chip" /> }));
vi.mock('@/hooks/useDriveWallet', () => ({ useDriveWallet: () => ({ wallet: null }) }));

const options = [
  { source: 'drive_wallet', walletId: 'w-product', label: 'Product wallet', driveName: 'Product', orgName: 'Northwind Labs', remainingCents: 192, remainingCredits: '192' },
  { source: 'own_credits', walletId: 'w-me', label: 'Your credits', driveName: null, orgName: null, remainingCents: 1482, remainingCredits: '1,482' },
];
const labelFor = (conversationId: string) => `${conversationId} wallet`;
const read = (conversationId: string) => ({
  conversationId,
  driveId: 'd-product',
  chosenWalletId: null,
  options: options.map((o) => (o.source === 'drive_wallet' ? { ...o, label: labelFor(conversationId) } : o)),
  resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'w-product', fallbackApplied: false, fallbackFrom: null },
});

const api = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), fetchWithAuth: api.fetchWithAuth, put: api.put }));

import { SpendSurfaceProvider } from '../SpendSurface';
import { SpendRefusalCard } from '../SpendRefusalCard';
import { ComposerSpendStrip } from '../ComposerSpendStrip';
import { SpendFallbackNotice } from '@/components/messages/SpendFallbackNotice';
import { AiBalanceWidget } from '@/components/billing/AiBalanceWidget';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { useSpendContextStore } from '@/stores/useSpendContextStore';
import { renderHook } from '@testing-library/react';

const conversationOf = (url: string) => decodeURIComponent(url.split('/api/wallets/conversations/')[1].split('?')[0]);

beforeEach(() => {
  vi.clearAllMocks();
  useSpendContextStore.setState({ entries: [], active: null });
  api.fetchWithAuth.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => read(conversationOf(url)) }));
  api.put.mockImplementation(async (url: string, body: { walletId: string }) => ({ ...read(conversationOf(url)), chosenWalletId: body.walletId }));
});

const fresh = (ui: React.ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

/** The page chat (registered first) and the sidebar chat (registered second, so it starts as the header's). */
const TwoSurfaces = ({ pageChild, sidebarChild, header = false, sidebarId = 'c-sidebar', withPage = true }: { pageChild?: React.ReactNode; sidebarChild?: React.ReactNode; header?: boolean; sidebarId?: string; withPage?: boolean }) => (
  <>
    {header && <AiBalanceWidget />}
    {withPage && (
      <SpendSurfaceProvider conversationId="c-page" driveId="d-product" isGlobal={false}>
        <div data-testid="page-chat">
          <ComposerSpendStrip conversationId="c-page" driveId="d-product" isGlobal={false} hasMessages={false} />
          {pageChild}
        </div>
      </SpendSurfaceProvider>
    )}
    <SpendSurfaceProvider conversationId={sidebarId} driveId="d-product" isGlobal={false}>
      <div data-testid="sidebar-chat">
        <ComposerSpendStrip conversationId={sidebarId} driveId="d-product" isGlobal={false} hasMessages={false} />
        {sidebarChild}
      </div>
    </SpendSurfaceProvider>
  </>
);

describe('spend controls with two chat surfaces mounted', () => {
  it('SPEND-3 (partial) SPEND-4 (partial) the refusal card switches the REFUSED conversation, not the surface registered last', async () => {
    fresh(<TwoSurfaces pageChild={<SpendRefusalCard refusal={{ source: 'drive_wallet', reason: 'source_paused', options: ['own_credits'] }} />} />);
    const card = within(screen.getByTestId('page-chat'));
    fireEvent.click(await card.findByRole('button', { name: 'Your credits' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/api/wallets/conversations/c-page', { walletId: 'w-me' });
  });

  it('SPEND-4 (partial) the fallback notice\'s Change switches the conversation the reply belongs to', async () => {
    fresh(<TwoSurfaces pageChild={<SpendFallbackNotice data={{ from: 'drive_wallet', to: 'own_credits', walletId: 'w-me' }} />} />);
    const page = within(screen.getByTestId('page-chat'));
    // Before any focus the header's registry points at the sidebar (registered last): the notice
    // must still name ITS conversation's wallet, so its binding is to its own surface (P3-A).
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-sidebar');
    expect(await page.findByText("Used your own credits because c-page wallet couldn't cover this.")).toBeTruthy();
    fireEvent.click(within(page.getByRole('status')).getByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Your credits/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/wallets/conversations/c-page', { walletId: 'w-me' }));
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('UI-8 (partial) the header chip follows the surface focused last and writes to exactly that conversation', async () => {
    fresh(<TwoSurfaces header />);
    // The person clicks into the page chat: the header now speaks for c-page.
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('page-chat'));
    });
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-page');
    fireEvent.click(await screen.findByTestId('spend-source-chip'));
    fireEvent.click(await screen.findByRole('radio', { name: /Your credits/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/wallets/conversations/c-page', { walletId: 'w-me' }));

    act(() => {
      fireEvent.pointerDown(screen.getByTestId('sidebar-chat'));
    });
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-sidebar');
  });

  it('UI-8 (partial) when the focused surface unmounts, the header falls back to the other mounted surface, not to nothing', () => {
    const { rerender } = fresh(<TwoSurfaces />);
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-sidebar');
    rerender(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SpendSurfaceProvider conversationId="c-page" driveId="d-product" isGlobal={false}>
          <div />
        </SpendSurfaceProvider>
      </SWRConfig>,
    );
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-page');
  });
  it('UI-8 (partial) an open header popover stays on the conversation it opened on when another surface changes its conversation (P2-A)', async () => {
    const { rerender } = fresh(<TwoSurfaces header />);
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('page-chat'));
    });
    fireEvent.click(await screen.findByTestId('spend-source-chip'));
    expect(await screen.findByRole('radio', { name: /c-page wallet/ })).toBeTruthy();
    // The sidebar moves to another conversation: it updates IN PLACE, focus order is unchanged.
    rerender(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><TwoSurfaces header sidebarId="c-sidebar-2" /></SWRConfig>);
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-page');
    expect(screen.queryByRole('radio', { name: /c-sidebar-2 wallet/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Your credits/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/api/wallets/conversations/c-page', { walletId: 'w-me' });
  });

  it('UI-8 (partial) an open header popover stays pinned even when a newly mounted surface becomes the active one (P2-A)', async () => {
    const { rerender } = fresh(<TwoSurfaces header />);
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('page-chat'));
    });
    fireEvent.click(await screen.findByTestId('spend-source-chip'));
    expect(await screen.findByRole('radio', { name: /c-page wallet/ })).toBeTruthy();
    // A third chat opens (an agent pane): a NEW surface does become the header's active one…
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <TwoSurfaces header />
        <SpendSurfaceProvider conversationId="c-pane" driveId="d-product" isGlobal={false}><div /></SpendSurfaceProvider>
      </SWRConfig>,
    );
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-pane');
    // …but the popover the person opened still lists, and switches, c-page.
    expect(screen.queryByRole('radio', { name: /c-pane wallet/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Your credits/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/api/wallets/conversations/c-page', { walletId: 'w-me' });
  });

  it('UI-8 (partial) if the pinned conversation\'s surface unmounts, the open popover closes instead of switching another conversation (P2-A)', async () => {
    const { rerender } = fresh(<TwoSurfaces header />);
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('page-chat'));
    });
    fireEvent.click(await screen.findByTestId('spend-source-chip'));
    expect(await screen.findByRole('radio', { name: /c-page wallet/ })).toBeTruthy();
    rerender(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><TwoSurfaces header withPage={false} /></SWRConfig>);
    await waitFor(() => expect(screen.queryByRole('radio', { name: /Your credits/ })).toBeNull());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('UI-8 (partial) a surface re-registering (new conversation) does not jump to the front of the focus order; only focus does', () => {
    const { rerender } = fresh(<TwoSurfaces />);
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('page-chat'));
    });
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-page');
    rerender(<SWRConfig value={{ provider: () => new Map() }}><TwoSurfaces sidebarId="c-sidebar-2" /></SWRConfig>);
    expect(useSpendContextStore.getState().active?.conversationId).toBe('c-page');
    expect(useSpendContextStore.getState().entries.map((e) => e.conversationId)).toEqual(['c-sidebar-2', 'c-page']);
  });

  it('SPEND-2 (partial) the sidebar keeps a compact strip after the first message below lg, where its sheet covers the header chip (P3-B)', async () => {
    fresh(
      <SpendSurfaceProvider conversationId="c-sidebar" driveId="d-product" isGlobal={false}>
        <ComposerSpendStrip conversationId="c-sidebar" driveId="d-product" isGlobal={false} hasMessages persistentBelowLg />
      </SpendSurfaceProvider>,
    );
    const strip = await screen.findByTestId('composer-spend-strip');
    expect(strip.className).toContain('lg:hidden');
    expect(strip.textContent).toContain('Spending from c-sidebar wallet');
  });

});

describe('useConversationSpend.choose', () => {
  it('SPEND-3 (partial) choosing PUTs the wallet to THIS conversation\'s route and shows what the server answered', async () => {
    const { result } = renderHook(() => useConversationSpend('c-page', { driveId: 'd-product', isGlobal: false }), {
      wrapper: ({ children }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>,
    });
    await waitFor(() => expect(result.current.spend?.conversationId).toBe('c-page'));
    await act(async () => {
      await result.current.choose('w-me');
    });
    expect(api.put).toHaveBeenCalledWith('/api/wallets/conversations/c-page', { walletId: 'w-me' });
    expect(result.current.spend?.chosenWalletId).toBe('w-me');
  });

  it('SPEND-3 (partial) a refused switch throws the route\'s error and leaves the stored choice as it was', async () => {
    api.put.mockRejectedValueOnce(new Error('wallet_not_available'));
    const { result } = renderHook(() => useConversationSpend('c-page', { driveId: 'd-product', isGlobal: false }), {
      wrapper: ({ children }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>,
    });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    await expect(result.current.choose('w-other')).rejects.toThrow('wallet_not_available');
    expect(result.current.spend?.chosenWalletId).toBeNull();
  });
});
