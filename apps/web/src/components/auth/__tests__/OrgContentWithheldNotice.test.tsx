import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock('swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('swr')>()),
  default: (key: string | null) => ({ data: key ? { locked: [] } : undefined, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/session-reauthentication', () => ({
  reauthenticateCurrentSession: vi.fn(),
  completeEmailedReauthentication: mocks.complete,
}));
vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (select: (s: { fetchDrives: () => void }) => unknown) => select({ fetchDrives: vi.fn() }),
}));

import { OrgContentWithheldNotice } from '../OrgContentWithheldNotice';
import { OrgReauthenticationPrompt } from '../OrgReauthenticationPrompt';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';

beforeEach(() => {
  mocks.complete.mockResolvedValue(false);
  act(() => useOrgReauthStore.getState().dismiss());
});

describe('content withheld by an org sign-in policy (D-OW-62)', () => {
  it('SEC-2 (partial) says the content is withheld for a passkey sign-in, and the action opens the one re-authentication prompt for each refusing org', async () => {
    render(
      <>
        <OrgContentWithheldNotice subject="Your Pulse summary" signInRequired={{ code: 'org_strong_sign_in_required', orgIds: ['org_a', 'org_b'] }} />
        <OrgReauthenticationPrompt />
      </>,
    );
    expect(screen.getByText(/Your Pulse summary is hidden because an organization it draws from requires strong sign-in \(passkey\)/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Use your passkey' }));

    expect(useOrgReauthStore.getState().denials).toEqual([
      { code: 'org_strong_sign_in_required', orgId: 'org_a' },
      { code: 'org_strong_sign_in_required', orgId: 'org_b' },
    ]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('requires strong sign-in (passkey)');
    expect(within(dialog).getByRole('button', { name: 'Use your passkey' })).toBeTruthy();
  });

  it('SEC-3 (partial) a sign-in that is too old asks for a fresh sign-in, with the reauthentication code', async () => {
    render(<OrgContentWithheldNotice subject="Your AI memory" signInRequired={{ code: 'org_reauthentication_required', orgIds: ['org_a'] }} />);
    expect(screen.getByText(/Your AI memory is hidden because an organization it draws from asks you to sign in again/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(useOrgReauthStore.getState().denials).toEqual([{ code: 'org_reauthentication_required', orgId: 'org_a' }]);
  });

  it('a refusal that names no org still opens the prompt', async () => {
    render(<OrgContentWithheldNotice subject="Your AI memory" signInRequired={{ code: 'org_reauthentication_required', orgIds: [] }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(useOrgReauthStore.getState().denials).toEqual([{ code: 'org_reauthentication_required', orgId: null }]);
  });
});
