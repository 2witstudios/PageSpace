'use client';

import { useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { CredentialResponse } from '@/types/google-identity';

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
  const isLoadingRef = useRef(false);
  const initializedRef = useRef(false);
  const scriptLoadedRef = useRef(false);

  const handleCredentialResponse = useCallback(
    async (response: CredentialResponse) => {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;

      try {
        // Get device info for ALL platforms (not just desktop)
        const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
        let deviceId: string;
        let deviceName: string;

        if (isDesktop && window.electron) {
          // Desktop: Get device info from Electron
          const deviceInfo = await window.electron.auth.getDeviceInfo();
          deviceId = deviceInfo.deviceId;
          deviceName = deviceInfo.deviceName;
        } else {
          // Web browser: Use fingerprint utility for device identification
          const { getOrCreateDeviceId, getDeviceName } = await import('@/lib/analytics');
          deviceId = getOrCreateDeviceId();
          deviceName = getDeviceName();
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
            deviceId,
            deviceName,
          }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
          toast.success("Welcome! You've been signed in with Google.");

          if (onSuccess) {
            onSuccess(data.user);
          }

          // Handle platform-specific token storage
          if (isDesktop && window.electron && data.tokens) {
            // Desktop: Store in Electron secure storage
            await window.electron.auth.storeSession({
              accessToken: data.tokens.accessToken,
              refreshToken: data.tokens.refreshToken,
              csrfToken: data.tokens.csrfToken,
              deviceToken: data.tokens.deviceToken,
            });
          } else if (data.deviceToken) {
            // Web: Store device token in localStorage for 90-day persistence
            try {
              localStorage.setItem('deviceToken', data.deviceToken);
            } catch (storageError) {
              // Storage may fail in private browsing or when quota exceeded
              // Log but don't block the sign-in flow
              console.warn('Failed to store device token:', storageError);
            }
          }

          // Redirect to dashboard or specified URL with auth=success param
          // Use full page navigation to ensure cookies are properly sent
          // and auth state is fully initialized (avoids client-side nav race condition)
          const targetUrl = redirectTo || data.redirectTo || '/dashboard';
          const urlWithAuth = new URL(targetUrl, window.location.origin);
          urlWithAuth.searchParams.set('auth', 'success');
          window.location.href = urlWithAuth.toString();
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
    [onSuccess, onError, redirectTo]
  );

  // FedCM migration: detailed prompt moment methods are deprecated
  // The browser now handles prompt display through FedCM
  // See: https://developers.google.com/identity/gsi/web/guides/fedcm-migration
  const handlePromptMoment = useCallback(() => {
    console.debug('Google One Tap prompt moment');
  }, []);

  useEffect(() => {
    // Don't initialize if disabled or already initialized
    if (disabled || initializedRef.current) return;

    // Don't run in desktop app (use regular OAuth flow instead)
    if (typeof window !== 'undefined' && window.electron?.isDesktop) {
      return;
    }

    // Don't run on mobile browsers - Google One Tap (FedCM) has limited support
    // on mobile and causes repeated prompts/re-renders leading to login loops
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      const userAgent = navigator.userAgent.toLowerCase();
      const isMobileBrowser =
        /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(
          userAgent
        );
      if (isMobileBrowser) {
        console.debug('Google One Tap: Skipping on mobile browser');
        return;
      }
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
