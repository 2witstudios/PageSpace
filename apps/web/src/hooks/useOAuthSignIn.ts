'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { isDesktopPlatform } from '@/lib/desktop-auth';

const EXTERNAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

type OAuthProvider = 'google' | 'apple';

export interface OAuthSigninBodyInput {
  platform: 'web' | 'desktop';
  deviceId: string;
  deviceName: string;
  inviteToken?: string;
  returnUrl?: string;
}

export const buildOAuthSigninBody = ({
  platform,
  deviceId,
  deviceName,
  inviteToken,
  returnUrl,
}: OAuthSigninBodyInput): Record<string, string> => ({
  platform,
  deviceId,
  deviceName,
  ...(inviteToken && { inviteToken }),
  ...(returnUrl && { returnUrl }),
});

export interface PostNativeAuthRedirectInput {
  isNewUser?: boolean;
  invitedDriveId?: string | null;
  returnUrl?: string;
}

/**
 * Decide where to land a user after a successful native (iOS) OAuth flow.
 *
 * Precedence: invite-consumed drive > returnUrl > new-user welcome > /dashboard.
 * Pure function — extracted so the redirect logic can be tested without
 * rendering the hook.
 */
export const buildPostNativeAuthRedirect = ({
  isNewUser,
  invitedDriveId,
  returnUrl,
}: PostNativeAuthRedirectInput): string => {
  if (invitedDriveId) return `/dashboard/${invitedDriveId}?invited=1`;
  if (returnUrl) return returnUrl;
  if (isNewUser) return '/dashboard?welcome=true';
  return '/dashboard';
};

interface UseOAuthSignInOptions {
  onStart?: () => void;
  onError?: (message: string) => void;
  inviteToken?: string;
  returnUrl?: string;
}

export function useOAuthSignIn({ onStart, onError, inviteToken, returnUrl }: UseOAuthSignInOptions = {}) {
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isAppleLoading, setIsAppleLoading] = useState(false);
  const [waitingProvider, setWaitingProvider] = useState<OAuthProvider | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const router = useRouter();

  const reportError = (message: string) => {
    toast.error(message);
    onError?.(message);
  };

  const cancelExternalAuth = useCallback(() => {
    setWaitingProvider(null);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (cleanupRef.current) cleanupRef.current();
    };
  }, []);

  const handleNativeSuccess = async (result: {
    isNewUser?: boolean;
    invitedDriveId?: string | null;
    returnUrl?: string;
    user?: { id: string; name: string | null; email: string | null; image?: string | null };
  }) => {
    const { useAuthStore } = await import('@/stores/useAuthStore');
    useAuthStore.getState().setAuthFailedPermanently(false);
    if (result.user) {
      useAuthStore.getState().setUser(result.user);
    }
    router.replace(buildPostNativeAuthRedirect({
      isNewUser: result.isNewUser,
      invitedDriveId: result.invitedDriveId,
      returnUrl: result.returnUrl,
    }));
  };

  const getDeviceInfo = async () => {
    if (isDesktopPlatform() && window.electron) {
      const info = await window.electron.auth.getDeviceInfo();
      return { platform: 'desktop' as const, deviceId: info.deviceId, deviceName: info.deviceName };
    }

    const { getOrCreateDeviceId, getDeviceName } = await import('@/lib/analytics');
    return { platform: 'web' as const, deviceId: getOrCreateDeviceId(), deviceName: getDeviceName() };
  };

  const initiateWebOAuth = async (endpoint: string, provider: OAuthProvider) => {
    const { platform, deviceId, deviceName } = await getDeviceInfo();
    const body = buildOAuthSigninBody({
      platform,
      deviceId,
      deviceName,
      inviteToken,
      returnUrl,
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();

      if (isDesktopPlatform() && window.electron?.auth?.openExternal) {
        // Clean up any prior waiting state before starting new attempt
        cancelExternalAuth();

        const result = await window.electron.auth.openExternal(data.url);
        if (!result.success) {
          reportError(result.error || 'Failed to open browser for sign-in');
          return;
        }

        setWaitingProvider(provider);

        timeoutRef.current = setTimeout(() => {
          cancelExternalAuth();
          toast.error('Sign-in timed out. Please try again.');
        }, EXTERNAL_AUTH_TIMEOUT_MS);

        const removeListener = window.electron.on('auth-error', (...args: unknown[]) => {
          const errorData = args[0] as { error?: string } | undefined;
          cancelExternalAuth();
          reportError(errorData?.error || 'Authentication failed');
        });
        cleanupRef.current = removeListener;

        return;
      }

      window.location.href = data.url;
    } else {
      const errorData = await response.json();
      reportError(errorData.error || `${provider} sign-in failed. Please try again.`);
    }
  };

  const handleGoogleSignIn = async () => {
    if (isGoogleLoading) return;
    setIsGoogleLoading(true);
    onStart?.();

    try {
      const { isNativeGoogleAuthAvailable, signInWithGoogle: nativeSignIn } =
        await import('@/lib/ios-google-auth');

      if (isNativeGoogleAuthAvailable()) {
        const result = await nativeSignIn({
          ...(inviteToken && { inviteToken }),
          ...(returnUrl && { returnUrl }),
        });
        if (result.success) {
          await handleNativeSuccess(result);
        } else if (result.error !== 'Sign-in cancelled') {
          reportError(result.error || 'Google sign-in failed');
        }
        return;
      }

      await initiateWebOAuth('/api/auth/google/signin', 'google');
    } catch (error) {
      console.error('Google sign-in error:', error);
      reportError('Network error. Please check your connection and try again.');
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    if (isAppleLoading) return;
    setIsAppleLoading(true);
    onStart?.();

    try {
      const { isNativeAppleAuthAvailable, signInWithApple: nativeSignIn } =
        await import('@/lib/ios-apple-auth');

      if (isNativeAppleAuthAvailable()) {
        const result = await nativeSignIn({
          ...(inviteToken && { inviteToken }),
          ...(returnUrl && { returnUrl }),
        });
        if (result.success) {
          await handleNativeSuccess(result);
        } else if (result.error !== 'Sign-in cancelled') {
          reportError(result.error || 'Apple sign-in failed');
        }
        return;
      }

      await initiateWebOAuth('/api/auth/apple/signin', 'apple');
    } catch (error) {
      console.error('Apple sign-in error:', error);
      reportError('Network error. Please check your connection and try again.');
    } finally {
      setIsAppleLoading(false);
    }
  };

  return {
    handleGoogleSignIn,
    handleAppleSignIn,
    isGoogleLoading,
    isAppleLoading,
    isWaitingForExternalAuth: waitingProvider !== null,
    waitingProvider,
    cancelExternalAuth,
  };
}
