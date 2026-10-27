// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useAuth } from './useAuth';
import { useOrgReauthStore } from '@/retained/stores/useOrgReauthStore';

const mocks = vi.hoisted(() => ({ push: vi.fn(), endSession: vi.fn(), reset: vi.fn() }));
vi.mock('@/retained-adapters/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: vi.fn() }) }));
vi.mock('@/retained/stores/useAuthStore', () => {
  const state = { user: null, isLoading: false, isAuthenticated: false, isRefreshing: false, hasHydrated: true, setHydrated: vi.fn(), endSession: mocks.endSession, setLoading: vi.fn() };
  return { useAuthStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }), authStoreHelpers: { loadSession: vi.fn(), shouldLoadSession: () => false, initializeEventListeners: vi.fn(), getSessionDuration: () => 0 } };
});
vi.mock('./useTokenRefresh', () => ({ useTokenRefresh: () => ({ refreshToken: vi.fn(), startTokenRefresh: vi.fn(), stopTokenRefresh: vi.fn() }) }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ post: vi.fn(), clearSessionCache: vi.fn() }));
vi.mock('@/retained/lib/auth/platform-storage', () => ({ getPlatformStorage: () => ({ platform: 'web', getStoredSession: async () => null }) }));
vi.mock('@/retained/lib/capacitor-bridge', () => ({ hasNativeCapability: () => false }));
vi.mock('@/retained/lib/analytics', () => ({ getOrCreateDeviceId: vi.fn(), getDeviceName: vi.fn() }));
vi.mock('@/retained/stores/useTabsStore', () => ({ useTabsStore: { setState: vi.fn() } }));
vi.mock('@/retained/hooks/useDrive', () => ({ useDriveStore: { getState: () => ({ reset: mocks.reset }) } }));
vi.mock('@/retained/stores/useHotkeyStore', () => ({ useHotkeyStore: { getState: () => ({ reset: mocks.reset }) } }));
vi.mock('swr', () => ({ mutate: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); useOrgReauthStore.getState().dismiss(); vi.clearAllMocks(); });

describe('organization privacy on retained logout', () => {
  it('purges saved setup plans and pending org denials before the next person signs in', async () => {
    localStorage.setItem('pagespace.orgSetup.user.org', 'invitation addresses');
    localStorage.setItem('unrelated', 'keep');
    useOrgReauthStore.getState().report({ code: 'org_strong_sign_in_required', orgId: 'northwind' });
    const { result } = renderHook(useAuth);
    await act(() => result.current.actions.logout());
    expect(localStorage.getItem('pagespace.orgSetup.user.org')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(useOrgReauthStore.getState().denials).toEqual([]);
    expect(mocks.endSession).toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith('/auth/signin');
  });
});
