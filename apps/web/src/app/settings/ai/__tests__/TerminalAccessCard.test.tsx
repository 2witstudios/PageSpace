import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminalAccessCard } from '../TerminalAccessCard';

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  put: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  put: mocks.put,
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

function mockGetResponse(config: Record<string, unknown>) {
  return { ok: true, json: async () => ({ config }) };
}

describe('TerminalAccessCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state before the config resolves', () => {
    mocks.fetchWithAuth.mockReturnValue(new Promise(() => {}));
    render(<TerminalAccessCard />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('given the initial GET fails, should show a distinct error state (not stuck on Loading…) with a working retry', async () => {
    mocks.fetchWithAuth.mockRejectedValueOnce(new Error('network down'));
    render(<TerminalAccessCard />);

    await waitFor(() => expect(screen.getByText('Could not load Terminal Access settings.')).toBeInTheDocument());
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    mocks.fetchWithAuth.mockResolvedValueOnce(
      mockGetResponse({ terminalAccess: false, machines: [], availableTerminals: [] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('Terminal Access')).toBeInTheDocument());
    expect(screen.queryByText('Could not load Terminal Access settings.')).not.toBeInTheDocument();
  });

  it('given terminalAccess is off, should render the toggle unchecked and hide the machines section', async () => {
    mocks.fetchWithAuth.mockResolvedValue(
      mockGetResponse({ terminalAccess: false, machines: [], availableTerminals: [] }),
    );
    render(<TerminalAccessCard />);
    await waitFor(() => expect(screen.getByText('Terminal Access')).toBeInTheDocument());
    expect(screen.queryByText('Machines')).not.toBeInTheDocument();
    expect(screen.queryByText(/unrestricted access to external content/)).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('given terminalAccess is on, should render a warning about the global assistant\'s broad input surface', async () => {
    mocks.fetchWithAuth.mockResolvedValue(
      mockGetResponse({ terminalAccess: true, machines: [{ kind: 'own' }], availableTerminals: [] }),
    );
    render(<TerminalAccessCard />);
    await waitFor(() => expect(screen.getByText('Own machine')).toBeInTheDocument());
    expect(screen.getByText(/unrestricted access to external content/)).toBeInTheDocument();
  });

  it('given terminalAccess is on with a configured own machine, should render it as the default machine', async () => {
    mocks.fetchWithAuth.mockResolvedValue(
      mockGetResponse({ terminalAccess: true, machines: [{ kind: 'own' }], availableTerminals: [] }),
    );
    render(<TerminalAccessCard />);
    await waitFor(() => expect(screen.getByText('Own machine')).toBeInTheDocument());
    expect(screen.getByText('Default')).toBeInTheDocument();
    // "Add own machine" is disabled since one is already configured.
    expect(screen.getByRole('button', { name: 'Add own machine' })).toBeDisabled();
  });

  it('given the toggle is switched on with no machines configured, should PUT terminalAccess=true with a default own machine', async () => {
    mocks.fetchWithAuth.mockResolvedValue(
      mockGetResponse({ terminalAccess: false, machines: [], availableTerminals: [] }),
    );
    mocks.put.mockResolvedValue({});
    render(<TerminalAccessCard />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/user/assistant-config', {
        terminalAccess: true,
        machines: [{ kind: 'own' }],
      }),
    );
  });

  it('given a configured machine is removed, should PUT the updated machines array', async () => {
    mocks.fetchWithAuth.mockResolvedValue(
      mockGetResponse({
        terminalAccess: true,
        machines: [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        availableTerminals: [{ id: 't1', title: 'Shared Terminal' }],
      }),
    );
    mocks.put.mockResolvedValue({});
    render(<TerminalAccessCard />);
    await waitFor(() => expect(screen.getByText('Shared Terminal')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove machine' })[1]);

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/user/assistant-config', {
        terminalAccess: true,
        machines: [{ kind: 'own' }],
      }),
    );
  });

  it('given the PUT fails, should roll back the optimistic update and show an error toast', async () => {
    mocks.fetchWithAuth.mockResolvedValue(
      mockGetResponse({ terminalAccess: false, machines: [], availableTerminals: [] }),
    );
    mocks.put.mockRejectedValue(new Error('nope'));
    render(<TerminalAccessCard />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('nope'));
    expect(screen.getByRole('switch')).not.toBeChecked();
  });
});
