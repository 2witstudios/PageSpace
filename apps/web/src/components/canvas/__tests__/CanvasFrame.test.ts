import React from 'react';
import { flushSync } from 'react-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

const useThemeMock = vi.fn();
vi.mock('next-themes', () => ({
  useTheme: () => useThemeMock(),
}));

const routerPushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

import { CANVAS_IFRAME_SANDBOX, CanvasFrame } from '../CanvasFrame';

// React 19.2.6 production build in this sandbox doesn't export `act`;
// @testing-library/react 16.x requires it. Polyfill with flushSync so React
// updates are committed synchronously. In CI (development React build) React.act
// exists and this is never reached.
if (typeof (React as Record<string, unknown>).act !== 'function') {
  (React as Record<string, unknown>).act = (cb: () => unknown) => {
    let result: unknown;
    flushSync(() => { result = cb(); });
    return result;
  };
}

/**
 * Security invariant guard for the in-app canvas iframe.
 *
 * CanvasFrame renders author HTML/JS via `srcDoc`. A `srcDoc` iframe inherits
 * the parent (app) origin, so the ONLY thing making it an opaque, isolated
 * origin is the absence of `allow-same-origin` in its sandbox. Granting
 * `allow-same-origin` together with `allow-scripts` would let author JavaScript
 * run AS the logged-in app — a full session/account compromise. This is one
 * token away, so it gets a dedicated regression test.
 */
describe('CANVAS_IFRAME_SANDBOX', () => {
  it('given the canvas iframe sandbox, should NEVER grant allow-same-origin', () => {
    expect(CANVAS_IFRAME_SANDBOX.split(/\s+/)).not.toContain('allow-same-origin');
  });

  it('given the canvas iframe sandbox, should run author JS in an opaque origin and allow new-tab links', () => {
    const tokens = CANVAS_IFRAME_SANDBOX.split(/\s+/);
    expect(tokens).toContain('allow-scripts');
    expect(tokens).toContain('allow-popups');
    expect(tokens).toContain('allow-popups-to-escape-sandbox');
    // Must not be able to navigate the app's own (top) tab.
    expect(tokens).not.toContain('allow-top-navigation');
    expect(tokens).not.toContain('allow-top-navigation-by-user-activation');
  });
});

describe('CanvasFrame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({ resolvedTheme: 'dark' });
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        links: [{
          driveId: 'drive-1',
          pageId: 'file-1',
          url: '/dashboard/drive-1/file-1/view?token=signed',
        }],
      }),
    });
  });

  it('given dashboard file links in canvas HTML, should render tokenized preview links for the sandboxed iframe', async () => {
    render(React.createElement(CanvasFrame, {
      html: '<img src="/dashboard/drive-1/file-1/view">',
      title: 'Canvas',
    }));

    await waitFor(() => {
      const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
      expect(iframe.srcdoc).toContain('/dashboard/drive-1/file-1/view?token=signed');
    });

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/canvas/file-view-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refs: [{ driveId: 'drive-1', pageId: 'file-1' }] }),
    });
  });
});

describe('CanvasFrame — theme sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({ resolvedTheme: 'dark' });
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ links: [] }),
    });
  });

  it('given injectThemeBridge, should pass it to renderCanvasDocument so the srcDoc contains the bridge script', () => {
    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain('pagespace-theme');
  });

  it('given resolvedTheme, should postMessage the theme to the iframe on mount', async () => {
    const mockPostMessage = vi.fn();

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    // jsdom does not create contentWindow for sandboxed iframes, so inject a
    // mock that the effect's postMessage call will use.
    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: mockPostMessage },
      configurable: true,
    });

    mockPostMessage.mockClear();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: iframe.contentWindow,
    }));

    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: 'pagespace-theme', isDark: true },
      '*',
    );
  });

  it('given a pagespace-theme-request message from the iframe, should respond with the current theme', async () => {
    const mockPostMessage = vi.fn();
    const mockContentWindow = { postMessage: mockPostMessage };

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    // Simulate the iframe's bridge script requesting the theme on load.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: mockContentWindow as unknown as MessageEventSource,
    }));

    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: 'pagespace-theme', isDark: true },
      '*',
    );
  });

  it('given resolvedTheme is light, should send isDark: false', async () => {
    useThemeMock.mockReturnValue({ resolvedTheme: 'light' });
    const mockPostMessage = vi.fn();
    const mockContentWindow = { postMessage: mockPostMessage };

    const { container } = render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: mockContentWindow as unknown as MessageEventSource,
    }));

    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: 'pagespace-theme', isDark: false },
      '*',
    );
  });

  it('given a message from a different source, should NOT respond', async () => {
    const mockPostMessage = vi.fn();
    const mockContentWindow = { postMessage: mockPostMessage };

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    // Simulate a message from a source that is NOT the iframe.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: window,
    }));

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe('CanvasFrame — navigation bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({ resolvedTheme: 'dark' });
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ links: [] }),
    });
  });

  it('given navigationBridge, should pass it to renderCanvasDocument so the srcDoc contains the bridge script', () => {
    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain('pagespace-navigate');
  });

  it('given a pagespace-navigate message with a valid dashboard page href from the iframe, should router.push it', () => {
    const mockContentWindow = { postMessage: vi.fn() };

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-navigate', href: '/dashboard/drive-1/page-1' },
      source: mockContentWindow as unknown as MessageEventSource,
    }));

    expect(routerPushMock).toHaveBeenCalledWith('/dashboard/drive-1/page-1');
  });

  it('given a pagespace-navigate message with a forged/invalid href, should NOT router.push (independent re-validation)', () => {
    const mockContentWindow = { postMessage: vi.fn() };

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-navigate', href: 'https://evil.example.com' },
      source: mockContentWindow as unknown as MessageEventSource,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-navigate', href: '/dashboard/drive-1/page-1/view' },
      source: mockContentWindow as unknown as MessageEventSource,
    }));

    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it('given a pagespace-navigate message from a different source, should NOT router.push', () => {
    const mockContentWindow = { postMessage: vi.fn() };

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-navigate', href: '/dashboard/drive-1/page-1' },
      source: window,
    }));

    expect(routerPushMock).not.toHaveBeenCalled();
  });

  // Regression: without a user-activation gate, author JS inside the canvas
  // iframe could postMessage `pagespace-navigate` on load (no real click at
  // all) and force the app's own tab to navigate — reopening the exact hole
  // CANVAS_IFRAME_SANDBOX closes by omitting allow-top-navigation*. jsdom has
  // no navigator.userActivation at all (verified separately), so the tests
  // above exercise the "API unsupported" fallback path; these explicitly
  // stub the API to exercise the gate itself.
  describe('given the User Activation API is available', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'userActivation');

    afterEach(() => {
      if (originalDescriptor) {
        Object.defineProperty(window.navigator, 'userActivation', originalDescriptor);
      } else {
        delete (window.navigator as { userActivation?: unknown }).userActivation;
      }
    });

    function stubUserActivation(isActive: boolean) {
      Object.defineProperty(window.navigator, 'userActivation', {
        value: { isActive, hasBeenActive: isActive },
        configurable: true,
      });
    }

    it('given no recent user gesture (isActive: false), should NOT router.push even for a valid href', () => {
      stubUserActivation(false);
      const mockContentWindow = { postMessage: vi.fn() };

      render(React.createElement(CanvasFrame, {
        html: '<p>x</p>',
        title: 'Canvas',
      }));

      const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
      Object.defineProperty(iframe, 'contentWindow', {
        value: mockContentWindow,
        configurable: true,
      });

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pagespace-navigate', href: '/dashboard/drive-1/page-1' },
        source: mockContentWindow as unknown as MessageEventSource,
      }));

      expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('given a recent user gesture (isActive: true), should router.push a valid href', () => {
      stubUserActivation(true);
      const mockContentWindow = { postMessage: vi.fn() };

      render(React.createElement(CanvasFrame, {
        html: '<p>x</p>',
        title: 'Canvas',
      }));

      const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
      Object.defineProperty(iframe, 'contentWindow', {
        value: mockContentWindow,
        configurable: true,
      });

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pagespace-navigate', href: '/dashboard/drive-1/page-1' },
        source: mockContentWindow as unknown as MessageEventSource,
      }));

      expect(routerPushMock).toHaveBeenCalledWith('/dashboard/drive-1/page-1');
    });
  });
});

describe('CanvasFrame — escape bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({ resolvedTheme: 'dark' });
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ links: [] }),
    });
  });

  it('given no onEscape prop, should NOT inject the escape bridge script into the srcDoc', () => {
    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    expect(iframe.srcdoc).not.toContain('pagespace-escape');
  });

  it('given an onEscape prop, should inject the escape bridge script into the srcDoc', () => {
    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
      onEscape: vi.fn(),
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain('pagespace-escape');
  });

  it('given a pagespace-escape message from the iframe, should call onEscape', () => {
    const mockContentWindow = { postMessage: vi.fn() };
    const onEscape = vi.fn();

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
      onEscape,
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-escape' },
      source: mockContentWindow as unknown as MessageEventSource,
    }));

    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('given a pagespace-escape message from a different source, should NOT call onEscape', () => {
    const mockContentWindow = { postMessage: vi.fn() };
    const onEscape = vi.fn();

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
      onEscape,
    }));

    const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      configurable: true,
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-escape' },
      source: window,
    }));

    expect(onEscape).not.toHaveBeenCalled();
  });
});
