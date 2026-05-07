/**
 * Contract tests for MagicLinkForm next= forwarding.
 *
 * The form is the source of truth for the user's intended destination at
 * the start of the round-trip. The signin page validates and supplies the
 * `nextPath` prop; the form forwards it verbatim into the POST body. The
 * send route re-validates — defense in depth, never trust across boundaries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/desktop-auth', () => ({
  getDevicePlatformFields: vi.fn().mockResolvedValue({}),
}));

import { MagicLinkForm } from '../MagicLinkForm';

const setupFetchMock = () => {
  const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    void _init;
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('/api/auth/login-csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'csrf-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/api/auth/magic-link/send')) {
      return new Response(JSON.stringify({ message: 'sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
  global.fetch = fetchSpy as unknown as typeof fetch;
  return fetchSpy;
};

describe('MagicLinkForm — next= forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a nextPath prop, forwards it as `next` in the send-route POST body', async () => {
    const fetchSpy = setupFetchMock();
    render(<MagicLinkForm nextPath="/dashboard/drive_abc" />);

    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign-in link/i }));

    const sendCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/api/auth/magic-link/send'),
    );
    expect(sendCall).toBeDefined();
    const init = sendCall![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.next).toBe('/dashboard/drive_abc');
    expect(body.email).toBe('user@example.com');
  });

  it('given no nextPath prop, omits `next` from the send-route POST body', async () => {
    const fetchSpy = setupFetchMock();
    render(<MagicLinkForm />);

    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign-in link/i }));

    const sendCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/api/auth/magic-link/send'),
    );
    expect(sendCall).toBeDefined();
    const init = sendCall![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('next');
  });

  it('given a nextPath and a no-account response, preserves next on the signup CTA href', async () => {
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      void _init;
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('/api/auth/login-csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'csrf-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/api/auth/magic-link/send')) {
        return new Response(JSON.stringify({ code: 'no_account' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<MagicLinkForm nextPath="/dashboard/drive_abc" />);

    await userEvent.type(screen.getByLabelText(/email/i), 'unknown@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign-in link/i }));

    const signupLink = await screen.findByRole('link', { name: /sign up/i });
    const href = signupLink.getAttribute('href');
    expect(href).toContain('email=unknown%40example.com');
    expect(href).toContain('next=%2Fdashboard%2Fdrive_abc');
  });
});
