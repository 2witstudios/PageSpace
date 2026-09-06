/**
 * The dark-launch gate's one client-visible read of `APP_HOSTING_ENABLED` —
 * `DriveEnvAppPane` must not render (and must not fetch anything else) until
 * this comes back `false`, so the field itself has to reflect the flag
 * exactly, with no auth in the way (it is a fact about the deployment, not
 * about any user's data).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsAppHostingEnabled } = vi.hoisted(() => ({
  mockIsAppHostingEnabled: vi.fn(),
}));

vi.mock('@pagespace/lib/services/app-hosting/app-hosting-env', () => ({
  isAppHostingEnabled: mockIsAppHostingEnabled,
}));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/app-hosting/capability', () => {
  it('reports enabled: true when the kill switch is on', async () => {
    mockIsAppHostingEnabled.mockReturnValue(true);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ enabled: true });
  });

  it('reports enabled: false when the kill switch is off (the default)', async () => {
    mockIsAppHostingEnabled.mockReturnValue(false);

    const response = await GET();
    const body = await response.json();

    expect(body).toEqual({ enabled: false });
  });
});
