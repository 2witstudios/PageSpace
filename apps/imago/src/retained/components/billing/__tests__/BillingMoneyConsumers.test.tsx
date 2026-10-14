// @vitest-environment jsdom
import '@/retained/test/setup';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const api = vi.hoisted(() => ({ post: vi.fn(), fetch: vi.fn() }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ post: api.post, fetchWithAuth: api.fetch }));
vi.mock('@stripe/react-stripe-js', () => ({ useStripe: () => null, useElements: () => null, PaymentElement: () => <div /> }));
vi.mock('../PromoCodeInput', () => ({ PromoCodeInput: () => null }));
vi.mock('@/retained/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/retained/hooks/useCreditBalance', () => ({ useCreditBalance: () => ({ balance: { subscriptionTier: 'pro' } }) }));
vi.mock('@/retained-adapters/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/usage' }));
vi.mock('@/retained/components/ui/dropdown-menu', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { DropdownMenu: wrapper, DropdownMenuContent: wrapper, DropdownMenuTrigger: wrapper, DropdownMenuItem: wrapper, DropdownMenuLabel: wrapper, DropdownMenuSeparator: () => null };
});
import { getPlan } from '@/retained/lib/subscription/plans';
import { UpcomingInvoice } from '../UpcomingInvoice';
import { InvoiceList } from '../InvoiceList';
import { EmbeddedCheckoutForm } from '../EmbeddedCheckoutForm';
import { PlanChangeConfirmation } from '../PlanChangeConfirmation';
import { BuyCreditsButton } from '../BuyCreditsButton';
const noop = vi.fn();
beforeEach(() => { api.post.mockReset(); api.fetch.mockReset(); api.post.mockResolvedValue({}); });
it('the native invoice table preserves real currency cents, including unpaid invoices', () => {
  render(<InvoiceList invoices={[{ id: 'invoice', number: 'INV1', status: 'open', amountDue: 1299, amountPaid: 0, currency: 'usd', created: '2026-10-01', periodStart: null, periodEnd: null, hostedInvoiceUrl: null, invoicePdf: null, description: 'Pro' }]} hasMore={false} onLoadMore={noop} />);
  expect(screen.getByText('$12.99')).toBeInTheDocument();
});
it('the upcoming invoice preserves line, subtotal and amount-due currency', () => {
  render(<UpcomingInvoice invoice={{ amountDue: 1500, total: 1299, currency: 'usd', nextPaymentAttempt: null, lines: [{ description: 'Pro', amount: 1299 }] }} />);
  expect(screen.getAllByText('$12.99')).toHaveLength(2);
  expect(screen.getByText('$15.00')).toBeInTheDocument();
});
it('native embedded checkout preserves original and discounted dollar amounts', () => {
  render(<EmbeddedCheckoutForm plan={getPlan('pro')!} subscriptionId="subscription" appliedPromo={{ promotionCodeId: 'promo', code: 'SAVE', coupon: { id: 'coupon', name: '20% off', percentOff: 20, amountOff: null, currency: 'usd', duration: 'once', durationInMonths: null }, discount: { originalAmount: 1500, discountedAmount: 1200, savings: 300, savingsFormatted: '$3.00' } }} onPromoApplied={noop} onApplyingPromoChange={noop} onSuccess={noop} onCancel={noop} />);
  expect(screen.getByText('$15')).toBeInTheDocument();
  expect(screen.getByText('$12.00')).toBeInTheDocument();
});
it('native plan change shows the server proration in dollars', async () => {
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ invoice: { amountDue: 1299, total: 1299, currency: 'usd', nextPaymentAttempt: null }, proration: { amount: 1299, items: [{ description: 'Proration', amount: 1299 }] } })));
  render(<PlanChangeConfirmation open onOpenChange={noop} currentPlan={getPlan('free')!} targetPlan={getPlan('pro')!} onSuccess={noop} />);
  await waitFor(() => expect(screen.getAllByText('$12.99')).toHaveLength(2));
});
it('the native custom topup dollar input buys canonical credits', async () => {
  render(<BuyCreditsButton />);
  const amount = screen.getByRole('spinbutton');
  expect(amount.getAttribute('min')).toBe('5');
  expect(amount.getAttribute('max')).toBe('500');
  fireEvent.change(amount, { target: { value: '10' } });
  fireEvent.keyDown(amount, { key: 'Enter' });
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/stripe/create-credit-topup', { credits: 1000 }));
});
