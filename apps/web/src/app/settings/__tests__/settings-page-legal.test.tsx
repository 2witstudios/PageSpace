import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useMCP', () => ({ useMCP: () => ({ isDesktop: false }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'user' } }) }));

const { platform } = vi.hoisted(() => ({ platform: { isNative: false } }));
vi.mock('@/hooks/useCapacitor', () => ({ useCapacitor: () => ({ isNative: platform.isNative }) }));
vi.mock('@/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({ showBilling: !platform.isNative, hideBilling: platform.isNative, isReady: true }),
}));

import SettingsPage from '../page';

describe('SettingsPage — Legal section', () => {
  beforeEach(() => {
    platform.isNative = false;
  });

  it('given a signed-in user in the native app, should list Privacy Policy and Terms of Service', () => {
    platform.isNative = true;
    render(<SettingsPage />);
    expect(screen.getByText('Privacy Policy')).toBeTruthy();
    expect(screen.getByText('Terms of Service')).toBeTruthy();
    expect(screen.queryByText('Privacy & Cookies')).toBeNull();
  });

  it('given the web, should list Privacy Policy and Terms of Service alongside cookie settings', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Privacy Policy')).toBeTruthy();
    expect(screen.getByText('Terms of Service')).toBeTruthy();
    expect(screen.getByText('Privacy & Cookies')).toBeTruthy();
  });
});
