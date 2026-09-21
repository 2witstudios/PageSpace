import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { isCapacitorApp, openExternalUrl } = vi.hoisted(() => ({
  isCapacitorApp: vi.fn(() => false),
  openExternalUrl: vi.fn(),
}));
vi.mock('@/lib/capacitor-bridge', () => ({ isCapacitorApp }));
vi.mock('@/lib/navigation/app-navigation', () => ({ openExternalUrl }));

import { MarketingLink } from '../MarketingLink';

describe('MarketingLink', () => {
  beforeEach(() => {
    isCapacitorApp.mockReturnValue(false);
    openExternalUrl.mockReset();
  });

  it('given the web, should navigate to the page normally', () => {
    render(<MarketingLink href="/terms">Terms</MarketingLink>);
    const link = screen.getByRole('link', { name: 'Terms' });
    expect(link.getAttribute('href')).toBe('/terms');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('given the native app, should open the absolute page URL in the system browser sheet instead of the web view', () => {
    isCapacitorApp.mockReturnValue(true);
    render(<MarketingLink href="/privacy">Privacy Policy</MarketingLink>);
    const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
    expect(notPrevented).toBe(false);
    expect(openExternalUrl).toHaveBeenCalledWith(`${window.location.origin}/privacy`);
  });
});
