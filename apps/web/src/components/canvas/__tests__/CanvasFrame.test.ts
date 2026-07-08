import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

import { CANVAS_IFRAME_SANDBOX, CanvasFrame } from '../CanvasFrame';
import { NonceProvider } from '@/contexts/NonceContext';

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

/**
 * A srcDoc iframe unconditionally inherits the embedder (app shell) document's
 * CSP, which is nonce-based. Author <script> tags need a matching nonce or the
 * inherited policy blocks them, even though canvas's own <meta> CSP would
 * allow them. This guards the fix: the nonce reaches CanvasFrame via context
 * and lands on the rendered author script.
 */
describe('CanvasFrame — CSP nonce threading', () => {
  it('given a NonceProvider with a known nonce, should stamp it onto the rendered author <script> in the iframe srcdoc', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ links: [] }) });

    render(
      React.createElement(
        NonceProvider,
        { nonce: 'test-nonce-123' },
        React.createElement(CanvasFrame, {
          html: '<script>console.log("hi")</script>',
          title: 'Canvas',
        }),
      ),
    );

    await waitFor(() => {
      const iframe = screen.getByTitle('Canvas') as HTMLIFrameElement;
      expect(iframe.srcdoc).toContain('<script nonce="test-nonce-123">console.log("hi")</script>');
    });
  });
});
