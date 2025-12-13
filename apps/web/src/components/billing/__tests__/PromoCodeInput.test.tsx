import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromoCodeInput, AppliedPromo } from '../PromoCodeInput';

// Mock the auth-fetch module
const mockPost = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

// Helper to create a valid promo response
const mockValidPromoResponse = (overrides: Partial<{
  promotionCodeId: string;
  coupon: AppliedPromo['coupon'];
  discount: AppliedPromo['discount'];
}> = {}) => ({
  valid: true,
  promotionCodeId: overrides.promotionCodeId ?? 'promo_123',
  coupon: overrides.coupon ?? {
    id: 'coupon_123',
    name: '20% Off',
    percentOff: 20,
    amountOff: null,
    currency: null,
    duration: 'forever' as const,
    durationInMonths: null,
  },
  discount: overrides.discount ?? {
    originalAmount: 2000,
    discountedAmount: 1600,
    savings: 400,
    savingsFormatted: '20%',
  },
});

describe('PromoCodeInput', () => {
  const mockOnPromoApplied = vi.fn();
  const defaultProps = {
    priceId: 'price_pro',
    onPromoApplied: mockOnPromoApplied,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render input and apply button', () => {
      render(<PromoCodeInput {...defaultProps} />);

      expect(screen.getByPlaceholderText('Enter promo code')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    });

    it('should disable apply button when input is empty', () => {
      render(<PromoCodeInput {...defaultProps} />);

      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    });

    it('should be disabled when disabled prop is true', () => {
      render(<PromoCodeInput {...defaultProps} disabled />);

      expect(screen.getByPlaceholderText('Enter promo code')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    });
  });

  describe('Input behavior', () => {
    it('should convert input to uppercase', async () => {
      const user = userEvent.setup();
      render(<PromoCodeInput {...defaultProps} />);

      const input = screen.getByPlaceholderText('Enter promo code');
      await user.type(input, 'save20');

      expect(input).toHaveValue('SAVE20');
    });

    it('should enable apply button when code is entered', async () => {
      const user = userEvent.setup();
      render(<PromoCodeInput {...defaultProps} />);

      const input = screen.getByPlaceholderText('Enter promo code');
      await user.type(input, 'SAVE20');

      expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
    });
  });

  describe('Promo validation', () => {
    it('should call API with correct parameters on apply', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      expect(mockPost).toHaveBeenCalledWith(
        '/api/stripe/validate-promo-code',
        { code: 'SAVE20', priceId: 'price_pro' }
      );
    });

    it('should apply code on Enter key press', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      const input = screen.getByPlaceholderText('Enter promo code');
      await user.type(input, 'SAVE20');
      await user.keyboard('{Enter}');

      expect(mockPost).toHaveBeenCalled();
    });

    it('should show loading state while validating', async () => {
      const user = userEvent.setup();
      // Make the post hang indefinitely
      mockPost.mockImplementation(() => new Promise(() => {}));

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      expect(screen.getByText('Validating')).toBeInTheDocument();
    });

    it('should call onPromoApplied with promo data on success', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(mockOnPromoApplied).toHaveBeenCalledWith({
          code: 'SAVE20',
          promotionCodeId: 'promo_123',
          coupon: expect.objectContaining({ id: 'coupon_123' }),
          discount: expect.objectContaining({ savings: 400 }),
        });
      });
    });
  });

  describe('Success state', () => {
    it('should show success badge when promo is applied', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText('SAVE20')).toBeInTheDocument();
        expect(screen.getByText(/20% off/)).toBeInTheDocument();
      });
    });

    it('should show duration label for forever coupon', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText(/forever/)).toBeInTheDocument();
      });
    });

    it('should show duration label for once coupon', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse({
        coupon: {
          id: 'coupon_once',
          name: 'First Month Discount',
          percentOff: 50,
          amountOff: null,
          currency: null,
          duration: 'once',
          durationInMonths: null,
        },
        discount: {
          originalAmount: 2000,
          discountedAmount: 1000,
          savings: 1000,
          savingsFormatted: '50%',
        },
      }));

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'FIRST50');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText(/first month/)).toBeInTheDocument();
      });
    });

    it('should show duration label for repeating coupon', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse({
        coupon: {
          id: 'coupon_repeat',
          name: '3 Months Discount',
          percentOff: 30,
          amountOff: null,
          currency: null,
          duration: 'repeating',
          durationInMonths: 3,
        },
        discount: {
          originalAmount: 2000,
          discountedAmount: 1400,
          savings: 600,
          savingsFormatted: '30%',
        },
      }));

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE30');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText(/3 months/)).toBeInTheDocument();
      });
    });

    it('should hide input and show remove button when promo applied', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Enter promo code')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Remove promotion code' })).toBeInTheDocument();
      });
    });
  });

  describe('Remove promo', () => {
    it('should remove promo and show input again on remove click', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      // Apply promo
      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText('SAVE20')).toBeInTheDocument();
      });

      // Remove promo
      await user.click(screen.getByRole('button', { name: 'Remove promotion code' }));

      expect(screen.getByPlaceholderText('Enter promo code')).toBeInTheDocument();
      expect(screen.queryByText('SAVE20')).not.toBeInTheDocument();
    });

    it('should call onPromoApplied with null when promo removed', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(mockValidPromoResponse());

      render(<PromoCodeInput {...defaultProps} />);

      // Apply promo
      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(mockOnPromoApplied).toHaveBeenCalledWith(expect.objectContaining({ code: 'SAVE20' }));
      });

      // Remove promo
      await user.click(screen.getByRole('button', { name: 'Remove promotion code' }));

      expect(mockOnPromoApplied).toHaveBeenLastCalledWith(null);
    });
  });

  describe('Error handling', () => {
    it('should show error message when promo code is invalid', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({
        valid: false,
        error: 'Invalid or expired promotion code',
      });

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'INVALID');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText('Invalid or expired promotion code')).toBeInTheDocument();
      });
    });

    it('should show generic error on network failure', async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new Error('Network error'));

      render(<PromoCodeInput {...defaultProps} />);

      await user.type(screen.getByPlaceholderText('Enter promo code'), 'SAVE20');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText('Failed to validate promotion code')).toBeInTheDocument();
      });
    });

    it('should clear error when typing new code', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({
        valid: false,
        error: 'Invalid code',
      });

      render(<PromoCodeInput {...defaultProps} />);

      const input = screen.getByPlaceholderText('Enter promo code');
      await user.type(input, 'INVALID');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(screen.getByText('Invalid code')).toBeInTheDocument();
      });

      // Type new code - error should clear
      await user.type(input, 'X');

      expect(screen.queryByText('Invalid code')).not.toBeInTheDocument();
    });

    it('should set aria-invalid on input when error', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({
        valid: false,
        error: 'Invalid code',
      });

      render(<PromoCodeInput {...defaultProps} />);

      const input = screen.getByPlaceholderText('Enter promo code');
      await user.type(input, 'INVALID');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => {
        expect(input).toHaveAttribute('aria-invalid', 'true');
      });
    });
  });
});
