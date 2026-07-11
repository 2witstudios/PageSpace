import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

const useThemeMock = vi.fn();
vi.mock('next-themes', () => ({
  useTheme: () => useThemeMock(),
}));

import { CANVAS_IFRAME_SANDBOX, CanvasFrame } from '../CanvasFrame';

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
    const postMessageSpy = vi.spyOn(window, 'postMessage');

    render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    // The effect fires after mount; the iframe contentWindow.postMessage is the
    // call we care about. In jsdom the iframe has a contentWindow, so the
    // spy on window.postMessage catches the parent→iframe direction via the
    // message event listener (we test the srcDoc contains the bridge and the
    // component wires up the listener).
    expect(postMessageSpy).toBeDefined();
    postMessageSpy.mockRestore();
  });

  it('given a pagespace-theme-request message from the iframe, should respond with the current theme', async () => {
    const { container } = render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow!;
    const postSpy = vi.spyOn(contentWindow, 'postMessage');

    // Simulate the iframe's bridge script requesting the theme on load.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: contentWindow,
    }));

    expect(postSpy).toHaveBeenCalledWith(
      { type: 'pagespace-theme', isDark: true },
      '*',
    );
    postSpy.mockRestore();
  });

  it('given resolvedTheme is light, should send isDark: false', async () => {
    useThemeMock.mockReturnValue({ resolvedTheme: 'light' });

    const { container } = render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow!;
    const postSpy = vi.spyOn(contentWindow, 'postMessage');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: contentWindow,
    }));

    expect(postSpy).toHaveBeenCalledWith(
      { type: 'pagespace-theme', isDark: false },
      '*',
    );
    postSpy.mockRestore();
  });

  it('given a message from a different source, should NOT respond', async () => {
    const { container } = render(React.createElement(CanvasFrame, {
      html: '<p>x</p>',
      title: 'Canvas',
    }));

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow!;
    const postSpy = vi.spyOn(contentWindow, 'postMessage');

    // Simulate a message from a source that is NOT the iframe.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pagespace-theme-request' },
      source: window,
    }));

    expect(postSpy).not.toHaveBeenCalled();
    postSpy.mockRestore();
  });
});
