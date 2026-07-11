import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setAppNavigator, navigateInApp } from '../app-navigator';

// The whole point of this module: the auth store's global `auth:expired` listener has no
// React context of its own, and a `window.location` hop from it is handed to Capacitor's
// WKNavigationDelegate, which cancels any top-level navigation outside the path prefix of
// server.url (https://pagespace.ai/dashboard) and opens it in Safari instead — blanking
// the iOS WebView on session expiry. A router transition is pushState and never reaches
// the delegate at all.
describe('navigateInApp', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: vi.fn() },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('routes through the registered navigator rather than touching window.location', () => {
    const navigate = vi.fn();
    setAppNavigator(navigate);

    navigateInApp('/auth/signin');

    expect(navigate).toHaveBeenCalledWith('/auth/signin');
    // The assertion that actually encodes the bug: a hard navigation here is what
    // punts the iOS shell to Safari and leaves the WebView blank.
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('uses the most recently registered navigator', () => {
    const stale = vi.fn();
    const current = vi.fn();
    setAppNavigator(stale);
    setAppNavigator(current);

    navigateInApp('/dashboard');

    expect(current).toHaveBeenCalledWith('/dashboard');
    expect(stale).not.toHaveBeenCalled();
  });
});
