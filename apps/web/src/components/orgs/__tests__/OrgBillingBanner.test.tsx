import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ paymentHere: false, assign: vi.fn(), startOrgSubscription: vi.fn() }));

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../OrgPaymentForm', () => ({ OrgPaymentForm: () => <div>payment element</div> }));
vi.mock('@/components/shared/FeedbackDialog', () => ({
  FeedbackDialog: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div>support dialog</div> : null),
}));
vi.mock('@/lib/orgs/payment-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/payment-routes')>()),
  documentAllowsPaymentElement: () => mocks.paymentHere,
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()), startOrgSubscription: mocks.startOrgSubscription }));

import { toast } from 'sonner';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { OrgBillingBanner } from '../OrgBillingBanner';

const reactivate = { kind: 'reactivate' as const, reason: 'canceled' as const, canManageBilling: true as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paymentHere = false;
  mocks.startOrgSubscription.mockResolvedValue({ subscription: {}, payment: { kind: 'confirm_payment', clientSecret: 'cs_1' }, activation: 'payment_required' });
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '', assign: mocks.assign }, writable: true });
});

describe('OrgBillingBanner', () => {
  it('SEAT-9 (partial): off the payment route, Reactivate loads Plan & seats fresh (the Payment Element needs a document without COEP)', async () => {
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={reactivate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(mocks.assign).toHaveBeenCalledWith('/orgs/org_1/settings/billing?reactivate=1');
    expect(mocks.startOrgSubscription).not.toHaveBeenCalled();
  });

  it('on Plan & seats, Reactivate opens the payment dialog in place', async () => {
    mocks.paymentHere = true;
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={reactivate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('payment element')).toBeTruthy();
    expect(mocks.startOrgSubscription).toHaveBeenCalledWith('org_1');
  });

  it('arriving with ?reactivate=1 on Plan & seats starts paying at once', async () => {
    mocks.paymentHere = true;
    window.location.search = '?reactivate=1';
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={reactivate} />);
    await waitFor(() => expect(mocks.startOrgSubscription).toHaveBeenCalledTimes(1));
  });

  it('SEAT-9 (partial) D-OW-44: a subscription changed outside PageSpace says it needs support, offers a way to reach it, and never claims the org is active', async () => {
    mocks.paymentHere = true;
    const onReactivated = vi.fn();
    mocks.startOrgSubscription.mockRejectedValue(
      new ApiRequestError('raw', 409, { error: 'raw', code: 'billing_requires_support' }),
    );
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={reactivate} onReactivated={onReactivated} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText(/changed outside PageSpace/)).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onReactivated).not.toHaveBeenCalled();
    expect(screen.queryByText('payment element')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Contact support' }));
    expect(screen.getByText('support dialog')).toBeTruthy();
  });

  it('SEAT-9 (partial) D-OW-30: a never-funded org whose payment is in shows activation finishing (not success), refreshes once, and leaves the rest to the realtime org:changed event', async () => {
    mocks.paymentHere = true;
    mocks.startOrgSubscription.mockResolvedValue({ subscription: { status: 'active' }, payment: { kind: 'none' }, activation: 'funding_pending' });
    const refreshed = vi.fn();
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={{ ...reactivate, reason: 'never_funded' }} onReactivated={refreshed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText(/Payment received — activation is finishing/)).toBeTruthy();
    expect(screen.getByText(/this page updates automatically/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).toBeNull();
    expect(refreshed).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
    expect(screen.queryByText('payment element')).toBeNull();
  });

  it('SEAT-9 (partial) D-OW-30: an active org nothing ever funded (unfunded_active) is sent to support, never told payment may be pending', async () => {
    mocks.paymentHere = true;
    const refreshed = vi.fn();
    mocks.startOrgSubscription.mockRejectedValue(new ApiRequestError('raw', 409, { error: 'raw', code: 'billing_requires_support' }));
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={{ ...reactivate, reason: 'never_funded' }} onReactivated={refreshed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByRole('button', { name: 'Contact support' })).toBeTruthy();
    expect(screen.queryByText(/activation is finishing/)).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('an org already active and funded just refreshes, with no toast claiming anything', async () => {
    mocks.paymentHere = true;
    mocks.startOrgSubscription.mockResolvedValue({ subscription: { status: 'active' }, payment: { kind: 'none' }, activation: 'active' });
    const refreshed = vi.fn();
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={reactivate} onReactivated={refreshed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
    expect(screen.queryByText(/activation is finishing/)).toBeNull();
  });

  it('a member sees the read-only notice and nothing to pay', () => {
    render(<OrgBillingBanner orgId="org_1" orgName="Northwind Labs" notice={{ kind: 'read_only', canManageBilling: false }} />);
    expect(screen.getByText('Northwind Labs is read-only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).toBeNull();
  });
});
