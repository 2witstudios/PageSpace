'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface UseOAuthSignInOptions {
  onStart?: () => void;
  onError?: (message: string) => void;
}

export function useOAuthSignIn({ onStart, onError }: UseOAuthSignInOptions = {}) {
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isAppleLoading, setIsAppleLoading] = useState(false);
  const router = useRouter();

  const reportError = (message: string) => {
    toast.error(message);
    onError?.(message);
  };

  const handleNativeSuccess = async (result: {
    isNewUser?: boolean;
    user?: { id: string; name: string | null; email: string | null; image?: string | null };
  }) => {
    const { useAuthStore } = await import('@/stores/useAuthStore');
    useAuthStore.getState().setAuthFailedPermanently(false);
    if (result.user) {
      useAuthStore.getState().setUser(result.user);
    }
    router.replace(result.isNewUser ? '/dashboard?welcome=true' : '/dashboard');
  };

  const getDeviceInfo = async () => {
    const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;

    if (isDesktop && window.electron) {
      const info = await window.electron.auth.getDeviceInfo();
      return { platform: 'desktop' as const, deviceId: info.deviceId, deviceName: info.deviceName };
    }

    const { getOrCreateDeviceId, getDeviceName } = await import('@/lib/analytics');
    return { platform: 'web' as const, deviceId: getOrCreateDeviceId(), deviceName: getDeviceName() };
  };

  const initiateWebOAuth = async (endpoint: string, providerName: string) => {
    const { platform, deviceId, deviceName } = await getDeviceInfo();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, deviceId, deviceName }),
    });

    if (response.ok) {
      const data = await response.json();
      window.location.href = data.url;
    } else {
      const errorData = await response.json();
      reportError(errorData.error || `${providerName} sign-in failed. Please try again.`);
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
        const result = await nativeSignIn();
        if (result.success) {
          await handleNativeSuccess(result);
        } else if (result.error !== 'Sign-in cancelled') {
          reportError(result.error || 'Google sign-in failed');
        }
        return;
      }

      await initiateWebOAuth('/api/auth/google/signin', 'Google');
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
        const result = await nativeSignIn();
        if (result.success) {
          await handleNativeSuccess(result);
        } else if (result.error !== 'Sign-in cancelled') {
          reportError(result.error || 'Apple sign-in failed');
        }
        return;
      }

      await initiateWebOAuth('/api/auth/apple/signin', 'Apple');
    } catch (error) {
      console.error('Apple sign-in error:', error);
      reportError('Network error. Please check your connection and try again.');
    } finally {
      setIsAppleLoading(false);
    }
  };

  return { handleGoogleSignIn, handleAppleSignIn, isGoogleLoading, isAppleLoading };
}
