import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runOrgSetup: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock('@/lib/orgs/run-org-setup', () => ({ runOrgSetup: mocks.runOrgSetup }));

import { PendingSetupCard } from '../PendingSetupCard';
import { loadPendingSetup, savePendingSetup } from '@/lib/orgs/pending-setup';

const plan = { driveIds: ['d1', 'd2'], invites: ['a@x.io'], selfEmail: 'me@x.io', driveNames: { d1: 'Product', d2: 'Design' } };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.runOrgSetup.mockResolvedValue([]);
});

describe('PendingSetupCard', () => {
  it('UI-6 (partial): once the org is paid, Finish setup runs the plan the abandoned checkout left, then forgets it', async () => {
    savePendingSetup('org_1', plan);
    const onDone = vi.fn();
    render(<PendingSetupCard orgId="org_1" orgName="Northwind Labs" notice={undefined} onDone={onDone} />);
    expect(screen.getByText(/move 2 drives in and invite 1 person/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(mocks.runOrgSetup).toHaveBeenCalledWith('org_1', plan));
    expect(loadPendingSetup('org_1')).toBeNull();
    expect(onDone).toHaveBeenCalled();
  });

  it('waits while the org is still unpaid', () => {
    savePendingSetup('org_1', plan);
    render(<PendingSetupCard orgId="org_1" orgName="Northwind Labs" notice={{ kind: 'reactivate', reason: 'incomplete', canManageBilling: true }} onDone={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/runs once the first payment goes through/)).toBeTruthy();
  });

  it('lists what did not go through', async () => {
    savePendingSetup('org_1', plan);
    mocks.runOrgSetup.mockResolvedValue(['Inviting a@x.io: Every seat is in use.']);
    render(<PendingSetupCard orgId="org_1" orgName="Northwind Labs" notice={undefined} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('Inviting a@x.io: Every seat is in use.')).toBeTruthy();
  });

  it('shows nothing when there is no saved plan', () => {
    const { container } = render(<PendingSetupCard orgId="org_1" orgName="Northwind Labs" notice={undefined} onDone={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
