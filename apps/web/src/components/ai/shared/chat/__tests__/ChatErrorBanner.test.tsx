/**
 * ChatErrorBanner tests
 *
 * The banner is the single error surface for every AI-chat view. Its job is to turn
 * the raw chat error — which for credit-gate denials is the raw JSON body, e.g.
 * `{"error":"out_of_credits", ...}` — into friendly copy and, when out of credits,
 * surface a "Buy credits" call to action. These tests pin that contract.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatErrorBanner } from '../ChatErrorBanner';

// Stub the billing CTA so the test stays isolated from billing visibility / Stripe.
vi.mock('@/components/billing/BuyCreditsButton', () => ({
  BuyCreditsButton: () => <button data-testid="buy-credits">Buy credits</button>,
}));

// The exact JSON body the credit gate returns before streaming starts.
const OUT_OF_CREDITS_BODY =
  '{"error":"out_of_credits","message":"You have run out of credits. Add credits or wait for your monthly allowance to reset."}';
const IN_FLIGHT_BODY =
  '{"error":"too_many_in_flight","message":"Too many AI requests in flight at once. Wait for one to finish, then try again."}';

describe('ChatErrorBanner', () => {
  it('renders nothing when there is no error', () => {
    const { container } = render(<ChatErrorBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when show is false, even with an error', () => {
    const { container } = render(
      <ChatErrorBanner error={new Error(OUT_OF_CREDITS_BODY)} show={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows friendly copy and the buy-credits CTA for an out-of-credits error', () => {
    const { getByTestId, getByText, queryByText } = render(
      <ChatErrorBanner error={new Error(OUT_OF_CREDITS_BODY)} />
    );
    // Friendly copy, not the raw JSON body.
    getByText(/used up your credits/i);
    expect(queryByText(/out_of_credits/)).toBeNull();
    expect(queryByText(/"error"/)).toBeNull();
    // CTA present.
    getByTestId('buy-credits');
  });

  it('shows in-flight copy with NO buy-credits CTA for a too-many-in-flight error', () => {
    const { getByText, queryByTestId, queryByText } = render(
      <ChatErrorBanner error={new Error(IN_FLIGHT_BODY)} />
    );
    getByText(/too many ai requests are running at once/i);
    expect(queryByText(/too_many_in_flight/)).toBeNull();
    expect(queryByTestId('buy-credits')).toBeNull();
  });

  it('shows generic copy with no CTA for an unrecognized error', () => {
    const { getByText, queryByTestId } = render(
      <ChatErrorBanner error={new Error('kaboom')} />
    );
    getByText(/something went wrong/i);
    expect(queryByTestId('buy-credits')).toBeNull();
  });

  it('renders a Dismiss button that invokes onClearError', () => {
    const onClearError = vi.fn();
    const { getByText } = render(
      <ChatErrorBanner error={new Error('kaboom')} onClearError={onClearError} />
    );
    fireEvent.click(getByText('Dismiss'));
    expect(onClearError).toHaveBeenCalledTimes(1);
  });

  it('omits the Dismiss button when no onClearError is provided', () => {
    const { queryByText } = render(<ChatErrorBanner error={new Error('kaboom')} />);
    expect(queryByText('Dismiss')).toBeNull();
  });
});
