import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ locked: [] as unknown[] }));
vi.mock('swr', () => ({ default: () => ({ data: { locked: mocks.locked } }) }));

import { LockedOrgDrives } from '../LockedOrgDrives';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';

beforeEach(() => {
  mocks.locked = [];
  act(() => useOrgReauthStore.getState().dismiss());
});

describe('locked org drives in the drive list (D-OW-45)', () => {
  it('SEC-2 (partial) an org drive the sign-in policy locks shows as locked, not gone, and Unlock opens the prompt', async () => {
    mocks.locked = [{ driveId: 'd1', driveName: 'Roadmap', orgId: 'org_nw', orgName: 'Northwind', code: 'org_strong_sign_in_required' }];
    render(<LockedOrgDrives />);
    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.getByText('Locked — use your passkey')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(useOrgReauthStore.getState().denials).toEqual([{ code: 'org_strong_sign_in_required', orgId: 'org_nw' }]);
  });

  it('renders nothing when no drive is locked', () => {
    const { container } = render(<LockedOrgDrives />);
    expect(container.innerHTML).toBe('');
  });
});
