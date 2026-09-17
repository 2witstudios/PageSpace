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
  deleteDialogProps: vi.fn(),
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
  clearCSRFToken: vi.fn(),
  clearSessionCache: vi.fn(),
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

vi.mock('@/components/oauth-grants/ConnectedAppsList', () => ({
  ConnectedAppsList: () => <div data-testid="connected-apps-list" />,
}));

vi.mock('@/components/dialogs/DeleteAccountDialog', () => ({
  DeleteAccountDialog: (props: unknown) => {
    mocks.deleteDialogProps(props);
    return null;
  },
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

  describe('account deletion and Sign in with Apple (Guideline 5.1.1(v))', () => {
    type DialogProps = { isOpen: boolean; appleSignInRevocation?: string; onConfirm: (email: string) => void };
    const lastDialogProps = (): DialogProps => mocks.deleteDialogProps.mock.calls.at(-1)?.[0] as DialogProps;

    const jsonResponse = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

    beforeEach(() => {
      mocks.fetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/account/drives-status') return jsonResponse({ soloDrives: [], multiMemberDrives: [] });
        if (url === '/api/account/apple-sign-in') return jsonResponse({ linked: true, revocation: 'manual' });
        return jsonResponse({});
      });
    });

    it('given an Apple user starting deletion, should hand the dialog their Sign in with Apple status', async () => {
      const user = userEvent.setup();
      render(<AccountPage />);

      await user.click(screen.getByRole('button', { name: /^Delete Account$/i }));

      await waitFor(() => {
        expect(lastDialogProps()).toEqual(expect.objectContaining({ isOpen: true, appleSignInRevocation: 'manual' }));
      });
      expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/api/account/apple-sign-in');
    });

    it('given the Apple status request fails, should still open the delete dialog without an Apple notice', async () => {
      mocks.fetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/account/drives-status') return jsonResponse({ soloDrives: [], multiMemberDrives: [] });
        throw new Error('network down');
      });
      const user = userEvent.setup();
      render(<AccountPage />);

      await user.click(screen.getByRole('button', { name: /^Delete Account$/i }));

      await waitFor(() => {
        expect(lastDialogProps()).toEqual(expect.objectContaining({ isOpen: true, appleSignInRevocation: undefined }));
      });
    });

    it('given deletion reports manual Apple steps, should land the user on the page that shows them', async () => {
      const location = { href: 'https://example.com/settings/account' };
      Object.defineProperty(window, 'location', { configurable: true, value: location });
      mocks.del.mockResolvedValue({ message: 'Account erasure queued', appleSignIn: 'manual' });
      const user = userEvent.setup();
      render(<AccountPage />);
      await user.click(screen.getByRole('button', { name: /^Delete Account$/i }));
      await waitFor(() => expect(lastDialogProps()?.isOpen).toBe(true));

      lastDialogProps().onConfirm('test@example.com');

      await waitFor(() => expect(location.href).toBe('/auth/account-deleted?appleSignIn=manual'), { timeout: 3000 });
    });

    it('given deletion needs no Apple steps, should still land on the in-app page, never the marketing home', async () => {
      const location = { href: 'https://example.com/settings/account' };
      Object.defineProperty(window, 'location', { configurable: true, value: location });
      mocks.del.mockResolvedValue({ message: 'Account erasure queued', appleSignIn: 'revoked' });
      const user = userEvent.setup();
      render(<AccountPage />);
      await user.click(screen.getByRole('button', { name: /^Delete Account$/i }));
      await waitFor(() => expect(lastDialogProps()?.isOpen).toBe(true));

      lastDialogProps().onConfirm('test@example.com');

      await waitFor(() => expect(location.href).toBe('/auth/account-deleted'), { timeout: 3000 });
    });
  });
});
