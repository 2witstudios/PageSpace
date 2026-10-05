import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SurfaceChoice, SurfaceDecision } from '@pagespace/lib/billing/spend-surface';
import type { ConversationSpend } from '@/hooks/useConversationSpend';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const spendState = vi.hoisted(() => ({
  spend: null as ConversationSpend | null,
  choose: vi.fn(async () => undefined),
}));
vi.mock('@/hooks/useConversationSpend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConversationSpend')>();
  return {
    ...actual,
    useConversationSpend: () => ({ spend: spendState.spend, choose: spendState.choose, error: undefined, isLoading: false, refresh: vi.fn() }),
  };
});
vi.mock('@/hooks/useDriveWallet', () => ({
  useDriveWallet: () => ({ wallet: { myCap: { dailyRemainingCents: 0, monthlyRemainingCents: 400 } } }),
}));
vi.mock('@/components/billing/CreditBalance', () => ({ CreditBalance: () => <div data-testid="personal-credit-chip" /> }));

import { SpendSourcePopover } from '../SpendSourcePopover';
import { SpendRefusalCardView, SpendRefusalCard } from '../SpendRefusalCard';
import { ComposerSpendStrip } from '../ComposerSpendStrip';
import { SpendSurfaceProvider } from '../SpendSurface';
import { AiBalanceWidget } from '@/components/billing/AiBalanceWidget';
import { useSpendContextStore } from '@/stores/useSpendContextStore';

const product: SurfaceChoice = { source: 'drive_wallet', walletId: 'w-product', label: 'Product wallet', driveName: 'Product', orgName: 'Northwind Labs', remainingCents: 192, remainingCredits: '192' };
const seat: SurfaceChoice = { source: 'seat_allowance', walletId: 'w-pool', label: 'Northwind Labs seat', driveName: 'Product', orgName: 'Northwind Labs', remainingCents: 54, remainingCredits: '54' };
const own: SurfaceChoice = { source: 'own_credits', walletId: 'w-me', label: 'Your credits', driveName: null, orgName: null, remainingCents: 148200, remainingCredits: '1,482' };
const spends = (choice: SurfaceChoice): SurfaceDecision => ({ kind: 'spend', source: choice.source, walletId: choice.walletId, fallbackApplied: false, fallbackFrom: null });
const conversation = (options: SurfaceChoice[], resolved: SurfaceDecision): ConversationSpend => ({ conversationId: 'c1', driveId: 'd-product', chosenWalletId: null, options, resolved });

beforeEach(() => {
  spendState.spend = null;
  spendState.choose.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  useSpendContextStore.setState({ entries: [], active: null });
});

describe('SpendSourcePopover: the header chip', () => {
  it('UI-8 (partial) the chip is one short token: the kind icon and a count, no wallet name, and bounded so the header never widens at lg', () => {
    render(
      <SpendSourcePopover
        chip={{ source: 'drive_wallet', text: '192 credits', tone: 'normal', ariaLabel: 'Spending from Product wallet: 192 credits' }}
        options={[product, seat, own]}
        selectedWalletId="w-product"
        driveName="Product"
        open={false}
        onOpenChange={() => {}}
        onChoose={async () => {}}
      />,
    );
    const chip = screen.getByTestId('spend-source-chip');
    expect(chip.textContent).toBe('192 credits');
    expect(chip.textContent).not.toContain('Product');
    // Below sm the count is hidden and the chip is the icon alone: still one token, still reachable (SPEND-2 on phones).
    expect(chip.className).toContain('inline-flex');
    expect(chip.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByTestId('spend-source-chip-text').className).toMatch(/\bhidden\b.*\bsm:inline\b/);
    expect(chip.className).toMatch(/max-w-\[8\.5rem\]/);
    expect(chip.className).toContain('shrink-0');
    expect(chip.className).toContain('whitespace-nowrap');
    expect(chip.getAttribute('aria-label')).toBe('Spending from Product wallet: 192 credits');
  });

  it('SPEND-3 (partial) picking another source in the popover switches this conversation and closes it', async () => {
    const onChoose = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    render(
      <SpendSourcePopover
        chip={{ source: 'drive_wallet', text: '192 credits', tone: 'normal', ariaLabel: 'x' }}
        options={[product, seat, own]}
        selectedWalletId="w-product"
        driveName="Product"
        open
        onOpenChange={onOpenChange}
        onChoose={onChoose}
      />,
    );
    expect(screen.getByRole('radio', { name: /Product wallet/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Funded by Northwind Labs')).toBeTruthy();
    expect(screen.getByText('54 credits left')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Northwind Labs seat/ }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('w-pool'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('SPEND-3 (partial) a refused switch shows the API code\'s copy and keeps the popover open', async () => {
    const { ApiRequestError } = await import('@/lib/auth/auth-fetch');
    const onChoose = vi.fn(async () => { throw new ApiRequestError('nope', 400, { error: 'nope', code: 'wallet_not_available' }); });
    const onOpenChange = vi.fn();
    render(
      <SpendSourcePopover chip={{ source: 'drive_wallet', text: '192 credits', tone: 'normal', ariaLabel: 'x' }} options={[product, own]} selectedWalletId="w-product" driveName={null} open onOpenChange={onOpenChange} onChoose={onChoose} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Your credits/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('AiBalanceWidget: which chip the header shows', () => {
  it('UI-8 (partial) the personal chip stays where the conversation in view has one source (SPEND-2, D20.8)', () => {
    useSpendContextStore.setState({ active: { conversationId: 'c1', driveId: 'd-product', isGlobal: false } });
    spendState.spend = conversation([own], spends(own));
    render(<AiBalanceWidget />);
    expect(screen.getByTestId('personal-credit-chip')).toBeTruthy();
    expect(screen.queryByTestId('spend-source-chip')).toBeNull();
  });

  it('UI-8 (partial) with more than one source the spending-from chip replaces it', () => {
    useSpendContextStore.setState({ active: { conversationId: 'c1', driveId: 'd-product', isGlobal: false } });
    spendState.spend = conversation([product, seat, own], spends(product));
    render(<AiBalanceWidget />);
    expect(screen.getByTestId('spend-source-chip').textContent).toBe('192 credits');
    expect(screen.queryByTestId('personal-credit-chip')).toBeNull();
  });

  it('UI-8 (partial) a paused drive wallet reads "Paused" on the chip', () => {
    useSpendContextStore.setState({ active: { conversationId: 'c1', driveId: 'd-product', isGlobal: false } });
    spendState.spend = conversation([product, seat, own], { kind: 'refuse', source: 'drive_wallet', reason: 'source_paused', options: [] });
    render(<AiBalanceWidget />);
    expect(screen.getByTestId('spend-source-chip').textContent).toBe('Paused');
  });
});

describe('SpendRefusalCard: the refusal card', () => {
  it('SPEND-4 (partial) names the empty source and who controls it, charges nothing, offers only the other sources, and has no ask for budget (D-OW-39)', () => {
    render(
      <SpendRefusalCardView
        refusal={{ source: 'drive_wallet', reason: 'source_empty', options: ['seat_allowance', 'own_credits'] }}
        choices={[product, seat, own]}
        myCap={null}
        now={new Date('2026-09-14T00:00:00Z')}
        onChoose={async () => {}}
      />,
    );
    expect(screen.getByText('Product wallet is empty for September')).toBeTruthy();
    expect(screen.getByText(/Nothing was charged\. The Northwind Labs Owner and Admins control this budget\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Northwind Labs seat · 54 credits' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Your credits' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Product wallet/ })).toBeNull();
    expect(screen.queryByText(/ask for budget/i)).toBeNull();
  });

  it('SPEND-4 (partial) choosing another source switches the conversation and never sends the message', async () => {
    const onChoose = vi.fn(async () => {});
    render(
      <SpendRefusalCardView refusal={{ source: 'drive_wallet', reason: 'source_paused', options: ['own_credits'] }} choices={[product, own]} myCap={null} onChoose={onChoose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Your credits' }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('w-me'));
    expect(toast.success).toHaveBeenCalledWith('This conversation now spends from Your credits. Send your message again.');
  });

  it('SPEND-4 (partial) the card never offers the source that was just refused, even when the payload lists it', () => {
    render(
      <SpendRefusalCardView refusal={{ source: 'drive_wallet', reason: 'source_empty', options: ['drive_wallet', 'own_credits'] }} choices={[product, own]} myCap={null} onChoose={async () => {}} />,
    );
    expect(screen.queryByRole('button', { name: /Product wallet/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Your credits' })).toBeTruthy();
  });

  it('WAL-7 (partial) a reached cap names the window that ran out (source_cap_reached)', () => {
    spendState.spend = conversation([product, seat, own], { kind: 'refuse', source: 'drive_wallet', reason: 'source_cap_reached', options: [] });
    render(
      <SpendSurfaceProvider conversationId="c1" driveId="d-product" isGlobal={false}>
        <SpendRefusalCard refusal={{ source: 'drive_wallet', reason: 'source_cap_reached', options: ['seat_allowance', 'own_credits'] }} />
      </SpendSurfaceProvider>,
    );
    expect(screen.getByText("You've reached your daily cap on Product wallet")).toBeTruthy();
  });

  it('SPEND-4 (partial) chosen_wallet_unavailable and guest_drive_wallet_off render their own copy', () => {
    const { rerender } = render(
      <SpendRefusalCardView refusal={{ source: null, reason: 'chosen_wallet_unavailable', options: ['own_credits'] }} choices={[product, own]} myCap={null} onChoose={async () => {}} />,
    );
    expect(screen.getByText('The source chosen for this conversation is no longer available')).toBeTruthy();
    rerender(<SpendRefusalCardView refusal={{ source: 'drive_wallet', reason: 'guest_drive_wallet_off', options: ['own_credits'] }} choices={[product, own]} myCap={null} onChoose={async () => {}} />);
    expect(screen.getByText("Guests can't spend from Product wallet")).toBeTruthy();
  });
});

describe('ComposerSpendStrip: the strip before the first message', () => {
  it('SPEND-2 (partial) names the source before the first message; its surface registers the conversation for the header chip', () => {
    spendState.spend = conversation([product, seat, own], spends(product));
    render(
      <SpendSurfaceProvider conversationId="c1" driveId="d-product" isGlobal={false}>
        <ComposerSpendStrip conversationId="c1" driveId="d-product" isGlobal={false} hasMessages={false} />
      </SpendSurfaceProvider>,
    );
    expect(screen.getByTestId('composer-spend-strip').textContent).toContain('Spending from Product wallet · 192 credits left');
    expect(useSpendContextStore.getState().active).toEqual({ conversationId: 'c1', driveId: 'd-product', isGlobal: false });
  });

  it('SPEND-4 (partial) when the chosen source is refused, the strip names it and what is wrong, and asks for a choice', () => {
    spendState.spend = conversation([product, seat, own], { kind: 'refuse', source: 'drive_wallet', reason: 'source_cap_reached', options: [] });
    render(<ComposerSpendStrip conversationId="c1" driveId="d-product" isGlobal={false} hasMessages={false} />);
    const strip = screen.getByTestId('composer-spend-strip');
    expect(strip.textContent).toContain('Product wallet: you reached your cap here · choose another source');
    expect(strip.textContent).not.toContain('Spending from');
    expect(screen.getByRole('button', { name: 'Choose' })).toBeTruthy();
  });

  it('SPEND-2 (partial) the strip is gone once the conversation has messages', () => {
    spendState.spend = conversation([product, seat, own], spends(product));
    render(<ComposerSpendStrip conversationId="c1" driveId="d-product" isGlobal={false} hasMessages />);
    expect(screen.queryByTestId('composer-spend-strip')).toBeNull();
  });
});
