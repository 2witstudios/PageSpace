'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useCapacitor } from './useCapacitor';
import { useAuth } from './useAuth';
import { post, del } from '@/lib/auth/auth-fetch';
import { getOrCreateDeviceId, getDeviceName } from '@/lib/analytics';
import type { Platform } from '@/lib/capacitor-bridge';

/**
 * `PermissionState` from `@capacitor/core`, plus the pre-native-answer state.
 *
 * All four native values are listed deliberately. Android reports
 * `'prompt-with-rationale'` from `checkPermissions()` once the user has refused
 * the POST_NOTIFICATIONS dialog at least once and the OS would still allow
 * another ask (Capacitor caches that in SharedPreferences from the request
 * result, so it survives a relaunch — see Bridge.validatePermissions/
 * getPermissionStates in @capacitor/android), and `'denied'` once the OS has
 * stopped allowing the ask at all. Omitting it and casting would have typed a
 * value the native layer really does return as one it cannot.
 */
type PermissionStatus = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unknown';

/**
 * Where a refusal is remembered across launches.
 *
 * The native permission state already survives a relaunch on both platforms,
 * but it says different things on each — iOS reports 'denied', Android reports
 * 'prompt-with-rationale' until the OS gives up and only then 'denied' — so
 * "has this user already said no?" is not one native value to compare against.
 * This record answers it directly, in one place, on every platform.
 *
 * It is a cache of the OS's answer, never a second source of truth: the
 * permission-check effect clears it the moment the OS stops holding a refusal,
 * so it can never outlive the refusal it stands for.
 */
const DENIAL_STORAGE_KEY = 'push_permission_denied';

/** Read the recorded refusal. Storage can throw (Safari private mode); never let that break registration. */
function hasRecordedDenial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(DENIAL_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Remember that the user refused, so the next launch does not ask again. */
function recordDenial(platform: Platform): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DENIAL_STORAGE_KEY, platform);
  } catch {
    // Storage unavailable: the native permission state is still the backstop.
  }
}

/** Forget the refusal — the user granted permission, possibly from system settings. */
function clearRecordedDenial(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(DENIAL_STORAGE_KEY);
  } catch {
    // Nothing to do; a stale record only costs an un-asked prompt.
  }
}

interface PushNotificationState {
  isSupported: boolean;
  permissionStatus: PermissionStatus;
  isRegistered: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * Whether this device has already refused the permission.
   *
   * Exposed so a settings surface can offer "enable notifications in system
   * settings" instead of a button that silently does nothing.
   */
  hasPreviouslyDenied: boolean;
}

interface PushNotificationActions {
  requestPermission: () => Promise<boolean>;
  registerToken: () => Promise<boolean>;
  unregisterToken: () => Promise<void>;
}

interface PushNotificationSchema {
  title?: string;
  body?: string;
  id: string;
  data: Record<string, unknown>;
}

interface ActionPerformed {
  actionId: string;
  notification: PushNotificationSchema;
}

export function usePushNotifications(): PushNotificationState & PushNotificationActions {
  const { capabilities, platform, isReady } = useCapacitor();
  const { isAuthenticated, user } = useAuth();
  const canPush = capabilities.push;

  const [state, setState] = useState<PushNotificationState>({
    isSupported: false,
    permissionStatus: 'unknown',
    isRegistered: false,
    isLoading: false,
    error: null,
    // Read inside the effect below rather than here: this initial state is also
    // what the server renders, and localStorage does not exist there.
    hasPreviouslyDenied: false,
  });

  const tokenRef = useRef<string | null>(null);
  // The token the server was last told about, not a boolean "have we registered
  // once?". FCM rotates a registration token on its own (app data cleared, a
  // restore onto a new device, a periodic refresh), and Capacitor re-emits
  // 'registration' with the new value while this hook stays mounted. A boolean
  // would make that second event a no-op and leave the server holding a token
  // that no longer routes anywhere — push delivery would stop until the next
  // cold start. Comparing the value instead lets a *different* token through
  // while still collapsing a repeat of the same one.
  const registeredTokenRef = useRef<string | null>(null);
  // Tokens whose POST is in flight. registeredTokenRef is only written after the
  // request resolves, so it cannot suppress a duplicate 'registration' event
  // that arrives while the first request is still open.
  const inFlightTokensRef = useRef(new Set<string>());
  const pushNotificationsRef = useRef<typeof import('@capacitor/push-notifications').PushNotifications | null>(null);
  const registerTokenWithServerRef = useRef<(token: string) => Promise<void>>(async () => { });
  const listenersRef = useRef<(() => void)[]>([]);

  // Check support and set up event listeners BEFORE marking supported.
  // isSupported unlocks the permission-check effect and, from consumers like
  // PushNotificationManager, an immediate registerToken()/register() call —
  // if that raced ahead of the 'registration' listener being attached, the
  // device-token event (APNs on iOS, FCM on Android) could fire with no
  // listener present to catch it.
  // Registering listeners first guarantees they exist by the time anything
  // downstream can trigger a native registration.
  useEffect(() => {
    if (!isReady) return;

    const checkSupport = async () => {
      // Capability, not platform: both native shells ship
      // @capacitor/push-notifications (APNs on iOS, FCM on Android), so the
      // question this asks is "can this platform receive a push?", answered by
      // the single table in capacitor-bridge.ts rather than by an equality
      // check that has to be found and edited per platform.
      if (canPush) {
        try {
          const { PushNotifications } = await import('@capacitor/push-notifications');
          pushNotificationsRef.current = PushNotifications;

          // Four independent listeners — register concurrently rather than
          // sequentially awaiting each native-bridge round trip.
          const [registrationListener, registrationErrorListener, receivedListener, actionListener] =
            await Promise.all([
              PushNotifications.addListener('registration', (token: { value: string }) => {
                console.log('[PushNotifications] Registered with token:', token.value.substring(0, 20) + '...');
                tokenRef.current = token.value;
                registerTokenWithServerRef.current(token.value);
              }),
              PushNotifications.addListener('registrationError', (error: { error: string }) => {
                console.error('[PushNotifications] Registration error:', error);
                setState(prev => ({
                  ...prev,
                  error: error.error,
                  isLoading: false,
                }));
              }),
              // Notification received while app is in foreground
              PushNotifications.addListener('pushNotificationReceived', (notification: PushNotificationSchema) => {
                console.log('[PushNotifications] Received:', notification);
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('push:received', {
                    detail: notification,
                  }));
                }
              }),
              // Notification tapped
              PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
                console.log('[PushNotifications] Action performed:', action);
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('push:action', {
                    detail: action,
                  }));
                }
              }),
            ]);

          listenersRef.current.push(
            () => registrationListener.remove(),
            () => registrationErrorListener.remove(),
            () => receivedListener.remove(),
            () => actionListener.remove(),
          );

          setState(prev => ({
            ...prev,
            isSupported: true,
            hasPreviouslyDenied: hasRecordedDenial(),
          }));
        } catch {
          setState(prev => ({ ...prev, isSupported: false }));
        }
      } else {
        setState(prev => ({ ...prev, isSupported: false }));
      }
    };

    checkSupport();

    return () => {
      listenersRef.current.forEach(remove => remove());
      listenersRef.current = [];
    };
  }, [canPush, isReady]);

  // Check permission status
  useEffect(() => {
    if (!state.isSupported || !pushNotificationsRef.current) return;

    const checkPermission = async () => {
      const PushNotifications = pushNotificationsRef.current;
      if (!PushNotifications) return;

      try {
        const result = await PushNotifications.checkPermissions();
        // Keep the record in step with the OS, which is the real authority on
        // whether this user has refused. Two states mean it is no longer
        // holding a refusal against them:
        //   'granted' — turned on from system settings since.
        //   'prompt'  — the OS has forgotten the refusal and would ask again.
        //               Android 11+ auto-revokes and RESETS permissions for an
        //               app that goes unused, landing exactly here; without
        //               this the record would outlive the refusal it stands for
        //               and the user could never be asked again.
        // 'denied' and 'prompt-with-rationale' both mean the refusal stands.
        const osHasNoRefusal = result.receive === 'granted' || result.receive === 'prompt';
        if (osHasNoRefusal) clearRecordedDenial();
        setState(prev => ({
          ...prev,
          permissionStatus: result.receive,
          hasPreviouslyDenied: osHasNoRefusal ? false : prev.hasPreviouslyDenied,
        }));
      } catch (error) {
        console.error('[PushNotifications] Error checking permissions:', error);
      }
    };

    checkPermission();
  }, [state.isSupported]);

  // Register token with server
  const registerTokenWithServer = useCallback(async (token: string) => {
    if (
      !isAuthenticated ||
      registeredTokenRef.current === token ||
      inFlightTokensRef.current.has(token)
    ) return;

    inFlightTokensRef.current.add(token);
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const deviceId = getOrCreateDeviceId();
      const deviceName = getDeviceName();

      await post('/api/notifications/push-tokens', {
        token,
        platform,
        deviceId,
        deviceName,
      });

      registeredTokenRef.current = token;
      setState(prev => ({
        ...prev,
        isRegistered: true,
        isLoading: false,
      }));

      console.log('[PushNotifications] Token registered with server');
    } catch (error) {
      console.error('[PushNotifications] Failed to register token:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to register token',
        isLoading: false,
      }));
    } finally {
      // Cleared on failure too, so a retry of the same token is not locked out.
      inFlightTokensRef.current.delete(token);
    }
  }, [isAuthenticated, platform]);

  // Keep ref updated with latest callback to avoid stale closure in listeners
  registerTokenWithServerRef.current = registerTokenWithServer;

  // Request permission and register for push notifications
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!state.isSupported || !pushNotificationsRef.current) {
      return false;
    }

    // A refusal stands until the OS itself stops holding it — at which point
    // the permission-check effect above clears the record and this guard opens
    // again. Without it the automatic registration path in
    // PushNotificationManager would call straight back into
    // requestPermissions() on every cold start: on Android the OS still allows
    // that ask while it reports 'prompt-with-rationale', so the dialog really
    // would reappear each launch.
    if (hasRecordedDenial()) {
      setState(prev => ({ ...prev, hasPreviouslyDenied: true, isLoading: false }));
      return false;
    }

    const PushNotifications = pushNotificationsRef.current;
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Request permission
      const permResult = await PushNotifications.requestPermissions();

      if (permResult.receive === 'granted') {
        clearRecordedDenial();
        setState(prev => ({ ...prev, permissionStatus: 'granted', hasPreviouslyDenied: false }));

        // Register with the platform push service (APNs on iOS, FCM on Android)
        await PushNotifications.register();

        return true;
      } else {
        recordDenial(platform);
        setState(prev => ({
          ...prev,
          permissionStatus: permResult.receive,
          hasPreviouslyDenied: true,
          isLoading: false,
        }));
        return false;
      }
    } catch (error) {
      console.error('[PushNotifications] Error requesting permission:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to request permission',
        isLoading: false,
      }));
      return false;
    }
  }, [state.isSupported, platform]);

  // Manually register token (if already have permission)
  const registerToken = useCallback(async (): Promise<boolean> => {
    if (!state.isSupported || !pushNotificationsRef.current) {
      return false;
    }

    if (state.permissionStatus !== 'granted') {
      return requestPermission();
    }

    const PushNotifications = pushNotificationsRef.current;

    try {
      await PushNotifications.register();
      return true;
    } catch (error) {
      console.error('[PushNotifications] Error registering:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to register',
      }));
      return false;
    }
  }, [state.isSupported, state.permissionStatus, requestPermission]);

  // Unregister token
  const unregisterToken = useCallback(async (): Promise<void> => {
    if (!tokenRef.current) return;

    try {
      await del('/api/notifications/push-tokens', { token: tokenRef.current });
      tokenRef.current = null;
      registeredTokenRef.current = null;
      setState(prev => ({ ...prev, isRegistered: false }));
      console.log('[PushNotifications] Token unregistered');
    } catch (error) {
      console.error('[PushNotifications] Failed to unregister token:', error);
    }
  }, []);

  // Auto-register when user is authenticated and permission is granted
  useEffect(() => {
    if (
      isAuthenticated &&
      state.isSupported &&
      state.permissionStatus === 'granted' &&
      !state.isRegistered &&
      registeredTokenRef.current !== tokenRef.current &&
      tokenRef.current
    ) {
      registerTokenWithServer(tokenRef.current);
    }
  }, [isAuthenticated, state.isSupported, state.permissionStatus, state.isRegistered, registerTokenWithServer]);

  // Clean up on logout
  useEffect(() => {
    if (!isAuthenticated && state.isRegistered) {
      unregisterToken();
    }
  }, [isAuthenticated, state.isRegistered, unregisterToken]);

  // Reset registration state when user changes
  useEffect(() => {
    registeredTokenRef.current = null;
    setState(prev => ({ ...prev, isRegistered: false }));
  }, [user?.id]);

  return {
    ...state,
    requestPermission,
    registerToken,
    unregisterToken,
  };
}
