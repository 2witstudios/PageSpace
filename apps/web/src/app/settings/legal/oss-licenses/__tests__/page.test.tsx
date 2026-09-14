import { render, screen } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import OssLicensesPage from '../page';

/**
 * The full-inventory notice is public-facing UI copy. It must never leak
 * private deal language (a seller's IP-sale disclosure), and its link must
 * land on the standalone sanitized inventory document — not the repo root,
 * where no promised inventory exists.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function renderPage() {
  return render(<OssLicensesPage />);
}

describe('OSS licenses settings page', () => {
  it('does not mention the seller, an IP disclosure, or a sale in the full-inventory notice', () => {
    const { container } = renderPage();
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/seller/i);
    expect(text).not.toMatch(/IP disclosure/i);
    expect(text).not.toMatch(/\bsale\b/i);
  });

  it('links directly to the standalone inventory document', () => {
    renderPage();

    const inventoryLink = screen.getByRole('link', {
      name: /OSS-INVENTORY\.md/i,
    });
    expect(inventoryLink).toHaveAttribute(
      'href',
      'https://github.com/2witstudios/PageSpace/blob/master/OSS-INVENTORY.md'
    );
    expect(
      screen.getByText(/complete open-source inventory/i)
    ).toBeInTheDocument();
  });
});
