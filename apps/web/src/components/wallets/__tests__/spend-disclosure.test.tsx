/**
 * SPEND-2 end to end in the browser layer: the header chip (AiBalanceWidget) and the composer
 * strip (ComposerSpendStrip) driven by the REAL hooks (useConversationSpend, useDriveSpend) and the
 * real focus (the `[driveId]` route segment), with only the HTTP reads answered here. What each
 * route answers is proven against Postgres in drive-wallet-service.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import type { SurfaceChoice, SurfaceDecision } from '@pagespace/lib/billing/spend-surface';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth, put: vi.fn(), ApiRequestError: class extends Error {} }));
vi.mock('@/stores/useSocketStore', () => ({ useSocketStore: (select: (s: { socket: null }) => unknown) => select({ socket: null }) }));
vi.mock('@/components/billing/CreditBalance', () => ({ CreditBalance: () => <div data-testid="personal-credit-chip" /> }));
const route = vi.hoisted(() => ({ params: {} as { driveId?: string } }));
vi.mock('next/navigation', () => ({
  useParams: () => route.params,
  usePathname: () => (route.params.driveId ? `/dashboard/${route.params.driveId}/p1` : '/dashboard'),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { AiBalanceWidget } from '@/components/billing/AiBalanceWidget';
import { ComposerSpendStrip } from '../ComposerSpendStrip';
import { useSpendContextStore } from '@/stores/useSpendContextStore';

const product: SurfaceChoice = { source: 'drive_wallet', walletId: 'w-product', label: 'Product wallet', driveName: 'Product', orgName: 'Northwind Labs', remainingCents: 19_200, remainingCredits: '192' };
const seat: SurfaceChoice = { source: 'seat_allowance', walletId: 'w-pool', label: 'Northwind Labs seat', driveName: 'Product', orgName: 'Northwind Labs', remainingCents: 5_400, remainingCredits: '54' };
const own: SurfaceChoice = { source: 'own_credits', walletId: 'w-me', label: 'Your credits', driveName: null, orgName: null, remainingCents: 148_200, remainingCredits: '1,482' };
const spends = (choice: SurfaceChoice): SurfaceDecision => ({ kind: 'spend', source: choice.source, walletId: choice.walletId, fallbackApplied: false, fallbackFrom: null });

/** What the two read routes answer, by URL. */
const answers = new Map<string, unknown>();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const conversationRead = (id: string, driveId: string, options: SurfaceChoice[], resolved: SurfaceDecision) =>
  answers.set(`/api/wallets/conversations/${id}`, { conversationId: id, driveId, chosenWalletId: null, options, resolved });
const driveRead = (driveId: string, options: SurfaceChoice[], resolved: SurfaceDecision) =>
  answers.set(`/api/wallets/drives/${driveId}`, { driveId, options, resolved });

const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
const renderSurfaces = (ui: ReactNode) => render(<>{ui}</>, { wrapper });

beforeEach(() => {
  answers.clear();
  route.params = {};
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => (answers.has(url) ? json(answers.get(url)) : new Response('{}', { status: 404 })));
  useSpendContextStore.setState({ entries: [], active: null });
});

describe('SPEND-2: the source is disclosed before the first message and in the header chip inside a drive', () => {
  it('SPEND-2 the source is named in the composer strip before the first message and in the header chip while inside a drive, which replaces the personal chip only with more than one source; one source keeps the personal chip and no strip; the strip is gone after the first message; a drive with no chat open still shows its source', async () => {
    route.params = { driveId: 'd-product' };

    // 1. Inside a drive with NO conversation in view: the chip names what a new conversation there spends.
    driveRead('d-product', [product, seat, own], spends(product));
    const header = renderSurfaces(<AiBalanceWidget />);
    await waitFor(() => expect(screen.getByTestId('spend-source-chip').textContent).toBe('192 credits'));
    expect(screen.queryByTestId('personal-credit-chip')).toBeNull();
    expect(screen.getByTestId('spend-source-chip').getAttribute('aria-label')).toBe('Spending from Product wallet: 192 credits');
    header.unmount();

    // 2. A conversation is open in the drive, before its first message: the strip names the source, and the
    //    header chip follows the conversation (a seat it chose), not the drive.
    conversationRead('c1', 'd-product', [product, seat, own], spends(seat));
    act(() => { useSpendContextStore.getState().register('surface-1', { conversationId: 'c1', driveId: 'd-product', isGlobal: false }); });
    const open = renderSurfaces(
      <>
        <AiBalanceWidget />
        <ComposerSpendStrip conversationId="c1" driveId="d-product" isGlobal={false} hasMessages={false} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('composer-spend-strip').textContent).toContain('Spending from Northwind Labs seat · 54 credits left'));
    await waitFor(() => expect(screen.getByTestId('spend-source-chip').textContent).toBe('54 credits'));
    expect(screen.queryByTestId('personal-credit-chip')).toBeNull();

    // 3. After the first message the strip is gone; the header chip keeps naming the source.
    open.rerender(
      <>
        <AiBalanceWidget />
        <ComposerSpendStrip conversationId="c1" driveId="d-product" isGlobal={false} hasMessages />
      </>,
    );
    expect(screen.queryByTestId('composer-spend-strip')).toBeNull();
    expect(screen.getByTestId('spend-source-chip').textContent).toBe('54 credits');
    open.unmount();
    act(() => { useSpendContextStore.getState().unregister('surface-1'); });

    // 4. One source (a personal drive with no wallet): no strip, and the personal chip stays — in the
    //    conversation and in the drive with none open.
    route.params = { driveId: 'd-home' };
    conversationRead('c2', 'd-home', [own], spends(own));
    driveRead('d-home', [own], spends(own));
    act(() => { useSpendContextStore.getState().register('surface-2', { conversationId: 'c2', driveId: 'd-home', isGlobal: false }); });
    const single = renderSurfaces(
      <>
        <AiBalanceWidget />
        <ComposerSpendStrip conversationId="c2" driveId="d-home" isGlobal={false} hasMessages={false} />
      </>,
    );
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/api/wallets/conversations/c2'));
    await waitFor(() => expect(screen.getByTestId('personal-credit-chip')).toBeTruthy());
    expect(screen.queryByTestId('composer-spend-strip')).toBeNull();
    expect(screen.queryByTestId('spend-source-chip')).toBeNull();
    single.unmount();
    act(() => { useSpendContextStore.getState().unregister('surface-2'); });

    const singleDrive = renderSurfaces(<AiBalanceWidget />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/api/wallets/drives/d-home'));
    expect(screen.getByTestId('personal-credit-chip')).toBeTruthy();
    expect(screen.queryByTestId('spend-source-chip')).toBeNull();
    singleDrive.unmount();

    // 5. Outside any drive with no conversation: the personal chip, and nothing is asked.
    route.params = {};
    fetchWithAuth.mockClear();
    renderSurfaces(<AiBalanceWidget />);
    expect(screen.getByTestId('personal-credit-chip')).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('SPEND-3 (partial) inside a drive with no conversation the popover is read only: a source is switched per conversation', async () => {
    route.params = { driveId: 'd-product' };
    driveRead('d-product', [product, seat, own], spends(product));
    renderSurfaces(<AiBalanceWidget />);
    const chip = await screen.findByTestId('spend-source-chip');
    act(() => { chip.click(); });
    const seatRow = await screen.findByRole('radio', { name: /Northwind Labs seat/ });
    expect((seatRow as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/What a new conversation in Product spends from/)).toBeTruthy();
  });
});
