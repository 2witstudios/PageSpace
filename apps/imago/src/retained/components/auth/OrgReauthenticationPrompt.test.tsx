// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  locked: [] as unknown[],
  reauth: vi.fn(),
  complete: vi.fn(),
  mutate: vi.fn(),
  fetchDrives: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('swr')>()),
  default: (key: string | null) => ({ data: key ? { locked: mocks.locked } : undefined, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: mocks.mutate }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/retained/lib/auth/session-reauthentication', () => ({
  reauthenticateCurrentSession: mocks.reauth,
  completeEmailedReauthentication: mocks.complete,
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (select: (s: { fetchDrives: typeof mocks.fetchDrives }) => unknown) => select({ fetchDrives: mocks.fetchDrives }),
}));

import { OrgReauthenticationPrompt, orgRequirements } from './OrgReauthenticationPrompt';
import { useOrgReauthStore } from '@/retained/stores/useOrgReauthStore';

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locked = [];
  mocks.complete.mockResolvedValue(false);
  mocks.reauth.mockResolvedValue({ status: 'done' });
  act(() => useOrgReauthStore.getState().dismiss());
});

const report = (code: 'org_strong_sign_in_required' | 'org_reauthentication_required', orgId: string | null = 'org_nw') =>
  act(() => useOrgReauthStore.getState().report({ code, orgId }));

describe('org re-authentication prompt (D-OW-45)', () => {
  it('stays closed until an org sign-in denial is reported', () => {
    render(<OrgReauthenticationPrompt />);
    expect(screen.queryByText('Confirm it’s you')).toBeNull();
  });

  it('SEC-2 (partial) names the org that requires strong sign-in and runs the passkey ceremony for this session', async () => {
    mocks.locked = [{ driveId: 'd1', driveName: 'Roadmap', orgId: 'org_nw', orgName: 'Northwind', code: 'org_strong_sign_in_required' }];
    render(<OrgReauthenticationPrompt />);
    report('org_strong_sign_in_required');

    expect(await screen.findByText('Northwind requires strong sign-in (passkey).')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use your passkey' }));

    await waitFor(() => expect(mocks.reauth).toHaveBeenCalledWith('org_strong_sign_in_required'));
    await waitFor(() => expect(useOrgReauthStore.getState().denials).toEqual([]));
    expect(mocks.mutate).toHaveBeenCalled();
    expect(mocks.fetchDrives).toHaveBeenCalledWith(false, true);
  });

  it('SEC-3 (partial) a sign-in that is too old asks to confirm and can wait on an emailed link', async () => {
    mocks.reauth.mockResolvedValue({ status: 'awaiting_email' });
    render(<OrgReauthenticationPrompt />);
    report('org_reauthentication_required', null);

    expect(await screen.findByText('An organization asks you to sign in again: your sign-in is older than it allows.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm it’s you' }));
    expect(await screen.findByText(/We emailed you a confirmation link/)).toBeTruthy();
    expect(mocks.reauth).toHaveBeenCalledWith('org_reauthentication_required');
  });

  it('SEC-2 (partial) with no passkey under strong sign-in it says how to get one, and keeps the prompt open', async () => {
    mocks.reauth.mockRejectedValue(new Error('no_passkey'));
    render(<OrgReauthenticationPrompt />);
    report('org_strong_sign_in_required');
    await userEvent.click(await screen.findByRole('button', { name: 'Use your passkey' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Strong sign-in needs a passkey. Add one in Settings → Account, then try again.'));
    expect(useOrgReauthStore.getState().denials).toHaveLength(1);
  });

  it('finishes an emailed confirmation link that landed back in the app', async () => {
    mocks.complete.mockResolvedValue(true);
    render(<OrgReauthenticationPrompt />);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
  });
});

describe('orgRequirements', () => {
  it('asks each org for its strongest requirement, once', () => {
    expect(orgRequirements(
      [{ code: 'org_reauthentication_required', orgId: 'org_a' }, { code: 'org_strong_sign_in_required', orgId: 'org_a' }],
      [{ driveId: 'd', driveName: 'D', orgId: 'org_a', orgName: 'A', code: 'org_reauthentication_required' }],
    )).toEqual([{ key: 'org_a', code: 'org_strong_sign_in_required', orgName: 'A' }]);
  });
});
