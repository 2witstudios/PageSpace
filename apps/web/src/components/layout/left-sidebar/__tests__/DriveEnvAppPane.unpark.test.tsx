import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { appState, post } = vi.hoisted(() => ({
  appState: { app: null as Record<string, unknown> | null },
  post: vi.fn(),
}));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscription: null, purchasable: false }) }),
  post,
  del: vi.fn(),
  ApiRequestError: class extends Error {},
}));
vi.mock('@/hooks/drive-envs/useDriveEnvApp', () => ({
  useDriveEnvApp: () => ({ app: appState.app, isLoading: false, mutate: vi.fn() }),
}));
vi.mock('@/hooks/drive-envs/useAppHostingCapability', () => ({ useAppHostingCapability: () => true }));
vi.mock('@/hooks/drive-envs/useAppLogs', () => ({ useAppLogs: () => [] }));
vi.mock('@/stores/useEditingSession', () => ({ useEditingSession: vi.fn() }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: () => null }));
vi.mock('@stripe/react-stripe-js', () => ({ PaymentElement: () => null, useElements: () => null, useStripe: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DriveEnvAppPane } from '../DriveEnvAppPane';

const parkedOnCap = {
  id: 'app-1',
  status: 'parked',
  tier: 'metered',
  subdomain: 'demo',
  url: 'https://demo.example',
  flyAppName: 'pgs-app-1',
  lastError: 'parked: org_member_cap_reached',
  // The server's answer for this viewer (permissions/app-unpark-authority): Marcus created it.
  viewerCanUnpark: true,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const renderPane = (canManage: boolean) => {
  render(<DriveEnvAppPane driveId="d1" envId="e1" envName="staging" canManage={canManage} isOwner={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Published app/ }));
};

describe('DriveEnvAppPane — the creator can resume (un-park) their parked app', () => {
  beforeEach(() => {
    appState.app = { ...parkedOnCap };
    post.mockReset().mockResolvedValue({});
  });

  it('WAL-2 (partial) the creator, a plain member, is offered Resume on their parked app, and it posts the resume action', () => {
    renderPane(false);
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(post).toHaveBeenCalledWith('/api/drives/d1/envs/e1/app/actions', { action: 'resume' });
  });

  it('WAL-2 (partial) a plain member who did not create it is offered no Resume', () => {
    appState.app = { ...parkedOnCap, viewerCanUnpark: false };
    renderPane(false);
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
  });

  it('the creator is offered no Stop or Resume on an app that is not parked', () => {
    appState.app = { ...parkedOnCap, status: 'stopped', lastError: null, viewerCanUnpark: false };
    renderPane(false);
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
  });
});
