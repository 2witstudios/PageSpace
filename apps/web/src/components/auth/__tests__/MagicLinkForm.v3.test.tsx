// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

vi.mock('@/lib/auth/magic-link-platform-fields', () => ({
  getMagicLinkPlatformFields: vi.fn(async () => ({})),
}));

vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => false,
}));

import { MagicLinkForm } from '../MagicLinkForm';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const mockSendResponse = (sendResponse: Response) => {
  const fetchSpy = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('/api/auth/login-csrf')) return jsonResponse(200, { csrfToken: 'csrf' });
    if (u.includes('/api/auth/magic-link/send')) return sendResponse;
    throw new Error(`Unexpected fetch: ${u}`);
  });
  global.fetch = fetchSpy as unknown as typeof fetch;
  return fetchSpy;
};

async function submitValidForm() {
  await userEvent.type(screen.getByLabelText(/email/i), 'lena@studio.example');
  await userEvent.click(screen.getByLabelText(/i agree/i));
  await userEvent.click(screen.getByRole('button', { name: /sign-in link/i }));
}

describe('MagicLinkForm — v3 (Imago enabled)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('given a successful send, should show "Check your email" as the page h1 with the cooldown resend and "Try a different email"', async () => {
    mockSendResponse(jsonResponse(200, { message: 'sent' }));
    render(<MagicLinkForm />);

    await submitValidForm();

    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/We sent a sign-in link to/i)).toHaveTextContent('lena@studio.example');
    expect(screen.getByText(/expires in 5 minutes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /try a different email/i })).toBeEnabled();
  });

  it('given a rate-limited send (429), should show the role=alert message with the submit disabled', async () => {
    mockSendResponse(jsonResponse(429, { retryAfter: 60 }));
    render(<MagicLinkForm />);

    await submitValidForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Please try again in 1 minute.');
    expect(screen.getByRole('button', { name: /sign-in link/i })).toBeDisabled();
  });

  it('given a rate-limited send, should keep the submit disabled while the retry countdown runs', async () => {
    mockSendResponse(jsonResponse(429, { retryAfter: 5 }));
    render(<MagicLinkForm />);

    await submitValidForm();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /sign-in link/i })).toBeDisabled();
  });
});
