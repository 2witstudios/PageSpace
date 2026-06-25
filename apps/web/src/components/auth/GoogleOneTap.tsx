'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CredentialResponse } from '@/types/google-identity';
import { detectInAppBrowser } from '@/lib/auth/browser-detection';
import { Button } from '@/components/ui/button';
import { useConsentStore } from '@/stores/useConsentStore';
import { shouldLoadThirdPartyScript } from '@pagespace/lib/consent';

/**
 * Platform eligibility for One Tap (desktop/native/mobile/in-app browsers are excluded).
 * Used by both the init effect and the pre-consent notice render so they stay in sync.
 */
function isOneTapPlatformEligible(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (window.electron?.isDesktop) return false;
  if ((window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
    return false;
  }
  const ua = navigator.userAgent;
  const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(ua);
  const isWebView = /\bwv\b|WebView/i.test(ua);
  if (isMobile || isWebView || detectInAppBrowser().isInApp) return false;
  return true;
}

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
  /** Pending invite token to consume on successful sign-in */
  inviteToken?: string;
}

const GOOGLE_GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

export function GoogleOneTap({
  onSuccess,
  onError,
  // GDPR Art 7(2): never auto-submit a returning user's credential before they can read
  // a notice and act. Defaults to false; callers must opt in explicitly.
  autoSelect = false,
  cancelOnTapOutside = true,
  context = 'signin',
  disabled = false,
  redirectTo,
  inviteToken,
}: GoogleOneTapProps) {
  const isLoadingRef = useRef(false);
  const initializedRef = useRef(false);
  const scriptLoadedRef = useRef(false);
  // null = still checking, true = logged in, false = not logged in
  const [sessionChecked, setSessionChecked] = useState<boolean | null>(null);

  // ePrivacy Art 5(3): the Google Identity Services script must not load before consent.
  const hydrateConsent = useConsentStore((s) => s.hydrate);
  const grantConsent = useConsentStore((s) => s.grant);
  const thirdPartyConsented = useConsentStore((s) => shouldLoadThirdPartyScript(s.state));

  useEffect(() => {
    hydrateConsent();
  }, [hydrateConsent]);

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
            ...(inviteToken && { inviteToken }),
          }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
          if (onSuccess) {
            onSuccess(data.user);
          }

          // Handle platform-specific token storage
          if (isDesktop && window.electron && data.sessionToken && data.csrfToken && data.deviceToken) {
            // Desktop: Store in Electron secure storage
            await window.electron.auth.storeSession({
              sessionToken: data.sessionToken,
              csrfToken: data.csrfToken,
              deviceToken: data.deviceToken,
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
    [onSuccess, onError, redirectTo, inviteToken]
  );

  // Check if user already has an active session before showing One Tap
  useEffect(() => {
    if (disabled) {
      setSessionChecked(true);
      return;
    }

    let cancelled = false;

    fetch('/api/auth/me', { credentials: 'include' })
      .then(res => {
        if (!cancelled) {
          setSessionChecked(res.ok);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // On network error, assume not logged in (allow One Tap)
          setSessionChecked(false);
        }
      });

    return () => { cancelled = true; };
  }, [disabled]);

  useEffect(() => {
    // Don't initialize if disabled, already initialized, or session check pending/positive
    if (disabled || initializedRef.current) return;
    // Wait for session check to complete
    if (sessionChecked === null) return;
    // User is already logged in - skip One Tap
    if (sessionChecked) return;

    // Desktop/native/mobile/in-app browsers use other flows (and FedCM loops on mobile).
    if (!isOneTapPlatformEligible()) return;

    // ePrivacy Art 5(3) / Art 13(1)(e)(f): do NOT inject the Google Identity Services
    // script or display the prompt until the user has consented via the notice below.
    if (!thirdPartyConsented) return;

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
      // FedCM migration: do NOT pass a momentListener callback to prompt().
      // PromptMomentNotification methods (isDisplayed, isNotDisplayed, etc.) are
      // deprecated and will stop functioning when FedCM becomes mandatory.
      // See: https://developers.google.com/identity/gsi/web/guides/fedcm-migration
      window.google.accounts.id.prompt();
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
        if (window.__webpack_nonce__) {
          script.nonce = window.__webpack_nonce__;
        }
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
  }, [disabled, sessionChecked, autoSelect, cancelOnTapOutside, context, handleCredentialResponse, thirdPartyConsented]);

  // Pre-consent notice (GDPR Art 13(1)(c)(d), ePrivacy Art 5(3)): when the user is not
  // logged in and has not yet consented to the third-party script, show a notice that
  // Google One Tap shares data with Google — and only load the script once they opt in.
  const showNotice =
    !disabled &&
    sessionChecked === false &&
    !thirdPartyConsented &&
    isOneTapPlatformEligible() &&
    !!process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;

  if (showNotice) {
    return (
      <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>
          Google One Tap lets you sign in with your Google account. Enabling it loads Google&apos;s
          sign-in script and shares your sign-in request with Google.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => grantConsent('preferences')}
        >
          Enable Google One Tap
        </Button>
      </div>
    );
  }

  // Otherwise nothing visible — the One Tap prompt is rendered by Google's library.
  return null;
}

export default GoogleOneTap;
