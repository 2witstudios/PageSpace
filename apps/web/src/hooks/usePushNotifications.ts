'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useCapacitor } from './useCapacitor';
import { useAuth } from './useAuth';
import { post, del } from '@/lib/auth/auth-fetch';
import { getOrCreateDeviceId, getDeviceName } from '@/lib/analytics';

type PermissionStatus = 'prompt' | 'granted' | 'denied' | 'unknown';

interface PushNotificationState {
  isSupported: boolean;
  permissionStatus: PermissionStatus;
  isRegistered: boolean;
  isLoading: boolean;
  error: string | null;
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
  const { isNative, platform, isReady } = useCapacitor();
  const { isAuthenticated, user } = useAuth();

  const [state, setState] = useState<PushNotificationState>({
    isSupported: false,
    permissionStatus: 'unknown',
    isRegistered: false,
    isLoading: false,
    error: null,
  });

  const tokenRef = useRef<string | null>(null);
  const hasRegisteredRef = useRef(false);
  const pushNotificationsRef = useRef<typeof import('@capacitor/push-notifications').PushNotifications | null>(null);

  // Check if push notifications are supported
  useEffect(() => {
    if (!isReady) return;

    const checkSupport = async () => {
      // Only supported on iOS for now
      if (isNative && platform === 'ios') {
        try {
          const { PushNotifications } = await import('@capacitor/push-notifications');
          pushNotificationsRef.current = PushNotifications;
          setState(prev => ({ ...prev, isSupported: true }));
        } catch {
          setState(prev => ({ ...prev, isSupported: false }));
        }
      } else {
        setState(prev => ({ ...prev, isSupported: false }));
      }
    };

    checkSupport();
  }, [isNative, platform, isReady]);

  // Check permission status
  useEffect(() => {
    if (!state.isSupported || !pushNotificationsRef.current) return;

    const checkPermission = async () => {
      const PushNotifications = pushNotificationsRef.current;
      if (!PushNotifications) return;

      try {
        const result = await PushNotifications.checkPermissions();
        setState(prev => ({
          ...prev,
          permissionStatus: result.receive as PermissionStatus,
        }));
      } catch (error) {
        console.error('[PushNotifications] Error checking permissions:', error);
      }
    };

    checkPermission();
  }, [state.isSupported]);

  // Set up listeners for push notification events
  useEffect(() => {
    if (!state.isSupported || !pushNotificationsRef.current) return;

    const PushNotifications = pushNotificationsRef.current;
    const listeners: (() => void)[] = [];

    const setupListeners = async () => {
      // Registration success
      const registrationListener = await PushNotifications.addListener(
        'registration',
        (token: { value: string }) => {
          console.log('[PushNotifications] Registered with token:', token.value.substring(0, 20) + '...');
          tokenRef.current = token.value;
          registerTokenWithServer(token.value);
        }
      );
      listeners.push(() => registrationListener.remove());

      // Registration error
      const registrationErrorListener = await PushNotifications.addListener(
        'registrationError',
        (error: { error: string }) => {
          console.error('[PushNotifications] Registration error:', error);
          setState(prev => ({
            ...prev,
            error: error.error,
            isLoading: false,
          }));
        }
      );
      listeners.push(() => registrationErrorListener.remove());

      // Notification received while app is in foreground
      const receivedListener = await PushNotifications.addListener(
        'pushNotificationReceived',
        (notification: PushNotificationSchema) => {
          console.log('[PushNotifications] Received:', notification);
          // Handle foreground notification
          // Could dispatch an event or update state here
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('push:received', {
              detail: notification,
            }));
          }
        }
      );
      listeners.push(() => receivedListener.remove());

      // Notification tapped
      const actionListener = await PushNotifications.addListener(
        'pushNotificationActionPerformed',
        (action: ActionPerformed) => {
          console.log('[PushNotifications] Action performed:', action);
          // Handle notification tap
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('push:action', {
              detail: action,
            }));
          }
        }
      );
      listeners.push(() => actionListener.remove());
    };

    setupListeners();

    return () => {
      listeners.forEach(remove => remove());
    };
  }, [state.isSupported]);

  // Register token with server
  const registerTokenWithServer = useCallback(async (token: string) => {
    if (!isAuthenticated || hasRegisteredRef.current) return;

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

      hasRegisteredRef.current = true;
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
    }
  }, [isAuthenticated, platform]);

  // Request permission and register for push notifications
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!state.isSupported || !pushNotificationsRef.current) {
      return false;
    }

    const PushNotifications = pushNotificationsRef.current;
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Request permission
      const permResult = await PushNotifications.requestPermissions();

      if (permResult.receive === 'granted') {
        setState(prev => ({ ...prev, permissionStatus: 'granted' }));

        // Register with APNs
        await PushNotifications.register();

        return true;
      } else {
        setState(prev => ({
          ...prev,
          permissionStatus: permResult.receive as PermissionStatus,
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
  }, [state.isSupported]);

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
      hasRegisteredRef.current = false;
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
      !hasRegisteredRef.current &&
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
    hasRegisteredRef.current = false;
    setState(prev => ({ ...prev, isRegistered: false }));
  }, [user?.id]);

  return {
    ...state,
    requestPermission,
    registerToken,
    unregisterToken,
  };
}
