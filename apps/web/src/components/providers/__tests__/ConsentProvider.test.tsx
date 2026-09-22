import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { isCapacitorApp } = vi.hoisted(() => ({ isCapacitorApp: vi.fn() }));
vi.mock('@/lib/capacitor-bridge', () => ({ isCapacitorApp }));

import ConsentProvider from '../ConsentProvider';

describe('ConsentProvider', () => {
  beforeEach(() => {
    document.cookie = 'ps_consent=; Max-Age=0; Path=/';
    isCapacitorApp.mockReset();
  });

  it('shows the cookie banner on the web before a decision', () => {
    isCapacitorApp.mockReturnValue(false);
    render(<ConsentProvider />);
    expect(screen.getByRole('dialog', { name: 'Cookie consent' })).toBeTruthy();
  });

  it('never shows the cookie banner inside the native app', () => {
    isCapacitorApp.mockReturnValue(true);
    render(<ConsentProvider />);
    expect(screen.queryByRole('dialog', { name: 'Cookie consent' })).toBeNull();
  });
});
