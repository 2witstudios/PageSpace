/**
 * Contract tests for MagicLinkForm.
 *
 * The form is the unified signin/signup entry point: typing an email + ticking
 * the ToS checkbox + clicking submit triggers a magic-link email. Auto-create
 * for unknown emails happens server-side; the form's contract is just to
 * collect (email, tosAccepted) and forward `next` from the signin page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Radix UI Checkbox renders an indicator that calls into @radix-ui/react-use-size,
// which constructs a ResizeObserver. jsdom doesn't implement it, so stub a no-op.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

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

describe('MagicLinkForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ToS gate', () => {
    it('disables the submit button until the ToS checkbox is ticked', async () => {
      setupFetchMock();
      render(<MagicLinkForm />);

      await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
      const submit = screen.getByRole('button', { name: /sign-in link/i });
      expect(submit).toBeDisabled();

      await userEvent.click(screen.getByLabelText(/i agree/i));
      expect(submit).toBeEnabled();
    });

    it('sends tosAccepted: true in the POST body once the checkbox is ticked', async () => {
      const fetchSpy = setupFetchMock();
      render(<MagicLinkForm />);

      await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
      await userEvent.click(screen.getByLabelText(/i agree/i));
      await userEvent.click(screen.getByRole('button', { name: /sign-in link/i }));

      const sendCall = fetchSpy.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('/api/auth/magic-link/send'),
      );
      expect(sendCall).toBeDefined();
      const body = JSON.parse((sendCall![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.tosAccepted).toBe(true);
      expect(body.email).toBe('user@example.com');
    });
  });

  describe('next= forwarding', () => {
    it('given a nextPath prop, forwards it as `next` in the send-route POST body', async () => {
      const fetchSpy = setupFetchMock();
      render(<MagicLinkForm nextPath="/dashboard/drive_abc" />);

      await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
      await userEvent.click(screen.getByLabelText(/i agree/i));
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
      await userEvent.click(screen.getByLabelText(/i agree/i));
      await userEvent.click(screen.getByRole('button', { name: /sign-in link/i }));

      const sendCall = fetchSpy.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('/api/auth/magic-link/send'),
      );
      expect(sendCall).toBeDefined();
      const init = sendCall![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('next');
    });
  });
});
