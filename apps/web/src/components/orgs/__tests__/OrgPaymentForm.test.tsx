import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirmPayment: vi.fn(), submit: vi.fn() }));

vi.mock('@stripe/react-stripe-js', () => ({
  useStripe: () => ({ confirmPayment: mocks.confirmPayment }),
  useElements: () => ({ submit: mocks.submit }),
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    queueMicrotask(onReady);
    return <div data-testid="payment-element" />;
  },
}));

import { OrgPaymentForm } from '../OrgPaymentForm';

const setup = () => {
  const onPaid = vi.fn();
  const onBack = vi.fn();
  render(<OrgPaymentForm orgId="org_nw" submitLabel="Pay $50.00 and create" backLabel="Pay later" onBack={onBack} onPaid={onPaid} />);
  return { onPaid, onBack };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submit.mockResolvedValue({});
});

describe('OrgPaymentForm', () => {
  it('UI-6 (partial): confirms the client secret with the Payment Element and reports a paid invoice', async () => {
    mocks.confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    const { onPaid } = setup();
    const pay = screen.getByRole('button', { name: 'Pay $50.00 and create' });
    await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(pay);
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(mocks.confirmPayment).toHaveBeenCalledWith(expect.objectContaining({
      redirect: 'if_required',
      confirmParams: { return_url: `${window.location.origin}/orgs/org_nw/settings` },
    }));
  });

  it('shows the card refusal and does not report payment', async () => {
    mocks.confirmPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    const { onPaid } = setup();
    const pay = screen.getByRole('button', { name: 'Pay $50.00 and create' });
    await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(pay);
    expect(await screen.findByText('Your card was declined.')).toBeTruthy();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('stops at an incomplete card before confirming', async () => {
    mocks.submit.mockResolvedValue({ error: { message: 'Your card number is incomplete.' } });
    setup();
    const pay = screen.getByRole('button', { name: 'Pay $50.00 and create' });
    await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(pay);
    expect(await screen.findByText('Your card number is incomplete.')).toBeTruthy();
    expect(mocks.confirmPayment).not.toHaveBeenCalled();
  });

  it('Pay later leaves without paying', async () => {
    const { onBack } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Pay later' }));
    expect(onBack).toHaveBeenCalled();
  });
});
