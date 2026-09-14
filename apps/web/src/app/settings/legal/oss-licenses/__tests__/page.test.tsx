import { render, screen } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import OssLicensesPage from '../page';

/**
 * The full-inventory notice is public-facing UI copy. It must never leak
 * private deal language (a seller's IP-sale disclosure). The inventory
 * source is the public PageSpace repository.
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

  it('names the public repository as the complete-inventory source', () => {
    renderPage();

    const repoLink = screen.getByRole('link', {
      name: /github\.com\/2witstudios\/PageSpace/i,
    });
    expect(repoLink).toHaveAttribute(
      'href',
      'https://github.com/2witstudios/PageSpace'
    );
    expect(screen.getByText(/complete open-source inventory/i)).toBeInTheDocument();
  });
});
