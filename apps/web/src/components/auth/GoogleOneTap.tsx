'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { CredentialResponse, PromptMomentNotification } from '@/types/google-identity';

interface GoogleOneTapProps {
  /** Called when sign-in is successful */
  onSuccess?: (user: { id: string; name: string; email: string }) => void;
  /** Called when sign-in fails */
  onError?: (error: string) => void;
  /** Whether to auto-select for returning users */
  autoSelect?: boolean;
  /** Whether to cancel when tapping outside the prompt */
  cancelOnTapOutside?: boolean;
  /** Context for the sign-in prompt */
  context?: 'signin' | 'signup' | 'use';
  /** Whether the component is disabled */
  disabled?: boolean;
  /** Redirect URL after successful sign-in */
  redirectTo?: string;
}

const GOOGLE_GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

export function GoogleOneTap({
  onSuccess,
  onError,
  autoSelect = true,
  cancelOnTapOutside = true,
  context = 'signin',
  disabled = false,
  redirectTo,
}: GoogleOneTapProps) {
  const router = useRouter();
  const isLoadingRef = useRef(false);
  const initializedRef = useRef(false);
  const scriptLoadedRef = useRef(false);

  const handleCredentialResponse = useCallback(
    async (response: CredentialResponse) => {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;

      try {
        // Get device info for desktop
        const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
        let deviceId: string | undefined;
        let deviceName: string | undefined;

        if (isDesktop && window.electron) {
          const deviceInfo = await window.electron.auth.getDeviceInfo();
          deviceId = deviceInfo.deviceId;
          deviceName = deviceInfo.deviceName;
        }

        // Send the credential to our backend for verification
        const res = await fetch('/api/auth/google/one-tap', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            credential: response.credential,
            platform: isDesktop ? 'desktop' : 'web',
            ...(deviceId && { deviceId }),
            ...(deviceName && { deviceName }),
          }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
          toast.success("Welcome! You've been signed in with Google.");

          if (onSuccess) {
            onSuccess(data.user);
          }

          // Handle desktop platform tokens
          if (isDesktop && window.electron && data.tokens) {
            await window.electron.auth.storeSession({
              accessToken: data.tokens.accessToken,
              refreshToken: data.tokens.refreshToken,
              csrfToken: data.tokens.csrfToken,
              deviceToken: data.tokens.deviceToken,
            });
          }

          // Redirect to dashboard or specified URL
          const targetUrl = redirectTo || data.redirectTo || '/dashboard';
          router.replace(targetUrl);
        } else {
          const errorMessage = data.error || 'Google sign-in failed. Please try again.';
          toast.error(errorMessage);
          if (onError) {
            onError(errorMessage);
          }
        }
      } catch (error) {
        console.error('Google One Tap error:', error);
        const errorMessage = 'Network error. Please check your connection and try again.';
        toast.error(errorMessage);
        if (onError) {
          onError(errorMessage);
        }
      } finally {
        isLoadingRef.current = false;
      }
    },
    [onSuccess, onError, router, redirectTo]
  );

  const handlePromptMoment = useCallback((notification: PromptMomentNotification) => {
    if (notification.isNotDisplayed()) {
      const reason = notification.getNotDisplayedReason();
      console.debug('Google One Tap not displayed:', reason);

      // Don't show error for common non-error cases
      if (reason === 'opt_out_or_no_session') {
        // User is not signed into Google or has opted out - this is expected
        return;
      }
      if (reason === 'suppressed_by_user') {
        // User has previously dismissed One Tap - respect their choice
        return;
      }
    }

    if (notification.isSkippedMoment()) {
      const reason = notification.getSkippedReason();
      console.debug('Google One Tap skipped:', reason);
    }

    if (notification.isDismissedMoment()) {
      const reason = notification.getDismissedReason();
      console.debug('Google One Tap dismissed:', reason);
    }
  }, []);

  useEffect(() => {
    // Don't initialize if disabled or already initialized
    if (disabled || initializedRef.current) return;

    // Don't run in desktop app (use regular OAuth flow instead)
    if (typeof window !== 'undefined' && window.electron?.isDesktop) {
      return;
    }

    const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) {
      console.warn('Google One Tap: Missing NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID');
      return;
    }

    const initializeGoogleOneTap = () => {
      if (!window.google?.accounts?.id) {
        console.warn('Google Identity Services not loaded');
        return;
      }

      if (initializedRef.current) return;
      initializedRef.current = true;

      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        auto_select: autoSelect,
        cancel_on_tap_outside: cancelOnTapOutside,
        context,
        use_fedcm_for_prompt: true,
        itp_support: true,
      });

      // Display the One Tap prompt
      window.google.accounts.id.prompt(handlePromptMoment);
    };

    // Load the Google Identity Services script if not already loaded
    if (!scriptLoadedRef.current) {
      const existingScript = document.querySelector(`script[src="${GOOGLE_GSI_SCRIPT_URL}"]`);

      if (existingScript) {
        // Script exists, check if google is available
        if (window.google?.accounts?.id) {
          initializeGoogleOneTap();
        } else {
          existingScript.addEventListener('load', initializeGoogleOneTap);
        }
        scriptLoadedRef.current = true;
      } else {
        // Create and load the script
        const script = document.createElement('script');
        script.src = GOOGLE_GSI_SCRIPT_URL;
        script.async = true;
        script.defer = true;
        script.onload = initializeGoogleOneTap;
        script.onerror = () => {
          console.error('Failed to load Google Identity Services script');
        };
        document.head.appendChild(script);
        scriptLoadedRef.current = true;
      }
    } else if (window.google?.accounts?.id) {
      initializeGoogleOneTap();
    }

    return () => {
      // Cancel One Tap on unmount
      if (window.google?.accounts?.id) {
        window.google.accounts.id.cancel();
      }
    };
  }, [disabled, autoSelect, cancelOnTapOutside, context, handleCredentialResponse, handlePromptMoment]);

  // This component doesn't render anything visible
  // The One Tap prompt is rendered by Google's library
  return null;
}

export default GoogleOneTap;
