import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SpendFallbackNotice } from '../SpendFallbackNotice';

describe('SpendFallbackNotice', () => {
  it('SPEND-4 (partial) shows the new source as a status, so a wallet switch is never silent', () => {
    render(<SpendFallbackNotice data={{ from: 'drive_wallet', to: 'own_credits', walletId: 'w-marcus' }} />);
    expect(screen.getByRole('status').textContent).toBe("Used your own credits because the drive wallet couldn't cover this.");
  });

  it('SPEND-4 (partial) renders nothing for a malformed payload', () => {
    const { container } = render(<SpendFallbackNotice data={{ from: 'drive_wallet' }} />);
    expect(container.innerHTML).toBe('');
  });
});
