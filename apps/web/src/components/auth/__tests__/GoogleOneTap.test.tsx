/**
 * Contract test for GoogleOneTap inviteToken forwarding.
 *
 * The signup/signin pages own the invite token (parsed from URL params or
 * server-resolved). The component is the courier — it must forward the token
 * verbatim into the POST body to /api/auth/google/one-tap so the route can
 * consume the pending invite during the same request that creates the user.
 *
 * Without this guarantee, an invitee who taps the auto-prompt is authenticated
 * but never added to the drive, and the inviter's pending list never clears.
 * The route already accepts and consumes the token (see one-tap route tests);
 * this test locks in that the client actually sends it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { CredentialResponse, IdConfiguration } from '@/types/google-identity';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: () => 'device-id-mock',
  getDeviceName: () => 'Test Device',
}));

import { GoogleOneTap } from '../GoogleOneTap';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface OneTapMocks {
  fetchSpy: ReturnType<typeof vi.fn>;
  capturedCallback: { current: ((r: CredentialResponse) => void) | null };
  hrefSetter: ReturnType<typeof vi.fn>;
}

const setupOneTapMocks = (): OneTapMocks => {
  const capturedCallback: OneTapMocks['capturedCallback'] = { current: null };

  const fetchSpy = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('/api/auth/me')) {
      return new Response(null, { status: 401 });
    }
    if (u.includes('/api/auth/google/one-tap')) {
      return new Response(JSON.stringify({ success: false, error: 'short-circuit' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
  global.fetch = fetchSpy as unknown as typeof fetch;

  const script = document.createElement('script');
  script.src = GSI_SRC;
  document.head.appendChild(script);

  const win = window as unknown as {
    google: {
      accounts: {
        id: {
          initialize: (config: IdConfiguration) => void;
          prompt: () => void;
          cancel: () => void;
        };
      };
    };
  };
  win.google = {
    accounts: {
      id: {
        initialize: (config: IdConfiguration) => {
          capturedCallback.current = config.callback ?? null;
        },
        prompt: vi.fn(),
        cancel: vi.fn(),
      },
    },
  };

  const hrefSetter = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new Proxy(
      { ...window.location, origin: 'http://localhost' },
      {
        set(target, prop, value) {
          if (prop === 'href') {
            hrefSetter(value);
            return true;
          }
          (target as Record<string | symbol, unknown>)[prop] = value;
          return true;
        },
        get(target, prop) {
          return (target as Record<string | symbol, unknown>)[prop];
        },
      },
    ),
  });

  return { fetchSpy, capturedCallback, hrefSetter };
};

const teardownOneTapMocks = () => {
  document.querySelectorAll(`script[src="${GSI_SRC}"]`).forEach((s) => s.remove());
  const win = window as unknown as { google?: unknown };
  delete win.google;
  vi.unstubAllEnvs();
};

const fireCredentialCallback = async (
  capturedCallback: OneTapMocks['capturedCallback'],
  fetchSpy: OneTapMocks['fetchSpy'],
) => {
  await waitFor(() => {
    expect(capturedCallback.current).toBeTypeOf('function');
  });
  await capturedCallback.current!({ credential: 'mock-jwt', select_by: 'user' });
  await waitFor(() => {
    const oneTapCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/auth/google/one-tap'),
    );
    expect(oneTapCall).toBeDefined();
  });
};

const readOneTapBody = (fetchSpy: OneTapMocks['fetchSpy']): Record<string, unknown> => {
  const oneTapCall = fetchSpy.mock.calls.find(
    ([url]) => typeof url === 'string' && url.includes('/api/auth/google/one-tap'),
  );
  const init = oneTapCall![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
};

describe('GoogleOneTap — inviteToken forwarding', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', 'mock-client-id.apps.googleusercontent.com');
  });

  afterEach(() => {
    teardownOneTapMocks();
    vi.clearAllMocks();
  });

  it('forwards inviteToken in the one-tap POST body when the prop is set', async () => {
    const { fetchSpy, capturedCallback } = setupOneTapMocks();
    render(<GoogleOneTap inviteToken="ps_invite_xyz" />);

    await fireCredentialCallback(capturedCallback, fetchSpy);

    const body = readOneTapBody(fetchSpy);
    expect(body.inviteToken).toBe('ps_invite_xyz');
    expect(body.credential).toBe('mock-jwt');
  });

  it('omits inviteToken from the one-tap POST body when the prop is not set', async () => {
    const { fetchSpy, capturedCallback } = setupOneTapMocks();
    render(<GoogleOneTap />);

    await fireCredentialCallback(capturedCallback, fetchSpy);

    const body = readOneTapBody(fetchSpy);
    expect(body).not.toHaveProperty('inviteToken');
    expect(body.credential).toBe('mock-jwt');
  });
});
