import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPage from '../page';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useDevices: vi.fn(),
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('@/hooks/useDevices', () => ({
  useDevices: mocks.useDevices,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  patch: mocks.patch,
  post: mocks.post,
  del: mocks.del,
}));

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: { emailVerified: new Date('2026-01-01T00:00:00.000Z') },
    error: null,
    isLoading: false,
  })),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock('@/components/settings/PasskeyManager', () => ({
  PasskeyManager: () => <div data-testid="passkey-manager" />,
}));

vi.mock('@/components/devices/DeviceList', () => ({
  DeviceList: () => <div data-testid="device-list" />,
}));

vi.mock('@/components/devices/RevokeAllDevicesDialog', () => ({
  RevokeAllDevicesDialog: () => null,
}));

vi.mock('@/components/dialogs/DeleteAccountDialog', () => ({
  DeleteAccountDialog: () => null,
}));

vi.mock('@/components/dialogs/DriveOwnershipDialog', () => ({
  DriveOwnershipDialog: () => null,
}));

vi.mock('@/components/dialogs/ImageCropperDialog', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  type ImageCropperDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCropComplete: (croppedBlob: Blob) => void;
  };

  return {
    ImageCropperDialog: ({ open, onOpenChange, onCropComplete }: ImageCropperDialogProps) => {
      const hasCroppedRef = React.useRef(false);

      React.useEffect(() => {
        if (!open || hasCroppedRef.current) {
          return;
        }

        hasCroppedRef.current = true;
        onCropComplete(new Blob(['avatar'], { type: 'image/png' }));
        onOpenChange(false);
      }, [open, onCropComplete, onOpenChange]);

      return null;
    },
  };
});

class MockFileReader {
  result = 'data:image/png;base64,avatar';
  onloadend: (() => void) | null = null;

  readAsDataURL(): void {
    this.onloadend?.();
  }
}

describe('AccountPage', () => {
  const mutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.useAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        image: null,
      },
      isLoading: false,
      isAuthenticated: true,
      isRefreshing: false,
      sessionDuration: 0,
      actions: {
        logout: vi.fn(),
        refreshAuth: vi.fn(),
        checkAuth: vi.fn(),
      },
      mutate,
    });

    mocks.useDevices.mockReturnValue({
      devices: [],
      refetch: vi.fn(),
    });

    mocks.patch.mockResolvedValue({
      id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
      image: null,
    });

    mocks.fetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ avatarUrl: '/api/avatar/user-1/avatar.png?t=1' }),
    });

    mutate.mockResolvedValue(undefined);
    vi.stubGlobal('FileReader', MockFileReader);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:avatar-preview'),
    });
  });

  it('given a pending cropped avatar, should upload it when saving account changes', async () => {
    const user = userEvent.setup();

    render(<AccountPage />);

    fireEvent.change(screen.getByLabelText(/Choose File/i), {
      target: {
        files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })],
      },
    });

    await screen.findByText('Selected: avatar.png');

    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
        '/api/account/avatar',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData),
        }),
      );
    });
    expect(mocks.patch).toHaveBeenCalledWith('/api/account', {
      name: 'Test User',
      email: 'test@example.com',
    });
    expect(mutate).toHaveBeenCalled();
  });
});
