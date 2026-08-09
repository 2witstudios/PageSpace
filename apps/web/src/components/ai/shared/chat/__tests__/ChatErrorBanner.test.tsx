/**
 * ChatErrorBanner tests
 *
 * The banner is the single error surface for every AI-chat view. It renders a typed
 * `AIErrorCause` (epic leaf 6.5) — friendly copy already resolved upstream by
 * `toErrorCause`/`parseLegacyErrorMessage` — and, when out of credits, surfaces a
 * "Buy credits" call to action. These tests pin that contract.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatErrorBanner } from '../ChatErrorBanner';
import type { AIErrorCause } from '@/lib/ai/shared/aiErrorCause';

// Stub the billing CTA so the test stays isolated from billing visibility / Stripe.
vi.mock('@/components/billing/BuyCreditsButton', () => ({
  BuyCreditsButton: () => <button data-testid="buy-credits">Buy credits</button>,
}));

const outOfCreditsCause: AIErrorCause = {
  code: 'out_of_credits',
  httpStatus: 402,
  message: 'You have run out of credits. Add credits or wait for your monthly allowance to reset.',
  retryable: false,
};
const inFlightCause: AIErrorCause = {
  code: 'too_many_in_flight',
  httpStatus: 429,
  message: 'Too many AI requests in flight at once. Wait for one to finish, then try again.',
  retryable: true,
};
const unknownCause: AIErrorCause = {
  code: 'unknown',
  httpStatus: null,
  message: 'Something went wrong. Please try again.',
  retryable: false,
};

describe('ChatErrorBanner', () => {
  it('renders nothing when there is no cause', () => {
    const { container } = render(<ChatErrorBanner cause={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when show is false, even with a cause', () => {
    const { container } = render(<ChatErrorBanner cause={outOfCreditsCause} show={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows friendly copy and the buy-credits CTA for an out-of-credits cause', () => {
    const { getByTestId, getByText, queryByText } = render(<ChatErrorBanner cause={outOfCreditsCause} />);
    getByText(/run out of credits/i);
    expect(queryByText(/"error"/)).toBeNull();
    // CTA present.
    getByTestId('buy-credits');
  });

  it('shows in-flight copy with NO buy-credits CTA for a too-many-in-flight cause', () => {
    const { getByText, queryByTestId } = render(<ChatErrorBanner cause={inFlightCause} />);
    getByText(/too many ai requests in flight/i);
    expect(queryByTestId('buy-credits')).toBeNull();
  });

  it('shows generic copy with no CTA for an unknown cause', () => {
    const { getByText, queryByTestId } = render(<ChatErrorBanner cause={unknownCause} />);
    getByText(/something went wrong/i);
    expect(queryByTestId('buy-credits')).toBeNull();
  });

  it('renders a Dismiss button that invokes onClearError', () => {
    const onClearError = vi.fn();
    const { getByText } = render(<ChatErrorBanner cause={unknownCause} onClearError={onClearError} />);
    fireEvent.click(getByText('Dismiss'));
    expect(onClearError).toHaveBeenCalledTimes(1);
  });

  it('omits the Dismiss button when no onClearError is provided', () => {
    const { queryByText } = render(<ChatErrorBanner cause={unknownCause} />);
    expect(queryByText('Dismiss')).toBeNull();
  });
});
