import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NotificationsSettingsPage from '../page';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  push: vi.fn(),
  patch: vi.fn(),
  fetchWithAuth: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  updateLevel: vi.fn(),
}));

let mockToastLevel: 'all' | 'mentions' | 'off' = 'all';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  patch: mocks.patch,
}));

const swrData = { preferences: [] };
const swrMutate = vi.fn();

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: swrData,
    mutate: swrMutate,
    isLoading: false,
  })),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock('@/hooks/useToastPreferences', () => ({
  useToastPreferences: () => ({
    level: mockToastLevel,
    isLoading: false,
    updateLevel: mocks.updateLevel,
  }),
}));

describe('NotificationsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToastLevel = 'all';
    mocks.useAuth.mockReturnValue({ user: { id: 'user-1' }, isLoading: false });
    mocks.updateLevel.mockResolvedValue(undefined);
  });

  it('renders all three in-app pop-up level options', () => {
    render(<NotificationsSettingsPage />);

    expect(screen.getByText('All notifications')).toBeInTheDocument();
    expect(screen.getByText('Mentions & DMs only')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('selects the radio matching the current preference level', () => {
    mockToastLevel = 'mentions';
    render(<NotificationsSettingsPage />);

    expect(screen.getByRole('radio', { name: /mentions & dms only/i })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('radio', { name: /^all notifications/i })).toHaveAttribute('data-state', 'unchecked');
  });

  it('calls updateLevel and shows a success toast when a different option is chosen', async () => {
    render(<NotificationsSettingsPage />);

    fireEvent.click(screen.getByRole('radio', { name: /^off/i }));

    expect(mocks.updateLevel).toHaveBeenCalledWith('off');
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('In-app pop-up preference updated'),
    );
  });

  it('shows an error toast and does not throw when updateLevel rejects', async () => {
    mocks.updateLevel.mockRejectedValueOnce(new Error('network error'));
    render(<NotificationsSettingsPage />);

    fireEvent.click(screen.getByRole('radio', { name: /^off/i }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Failed to update in-app pop-up preference'),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
