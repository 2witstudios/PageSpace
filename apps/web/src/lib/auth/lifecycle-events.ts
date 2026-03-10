import { createClientLogger } from '@/lib/logging/client-logger';
import { isCapacitorApp, getPlatform } from '@/lib/capacitor-bridge';
import type { PowerState } from './types';
import type { RefreshCallback } from './session-refresh';

const logger = createClientLogger({ namespace: 'auth', component: 'lifecycle-events' });

export interface LifecycleManager {
  initialize: (
    onSessionCleared: () => void,
    onCSRFTokenCleared: () => void,
    refreshSession: RefreshCallback
  ) => void;
  getPowerState: () => PowerState;
  cleanup: () => void;
}

export function createLifecycleManager(): LifecycleManager {
  let powerState: PowerState = {
    isSuspended: false,
    suspendTime: null,
  };
  let powerEventCleanups: (() => void)[] = [];
  let authClearedCleanup: (() => void) | null = null;
  let initialized = false;

  function initialize(
    onSessionCleared: () => void,
    onCSRFTokenCleared: () => void,
    refreshSession: RefreshCallback
  ): void {
    if (initialized) return;
    initialized = true;

    if (typeof window !== 'undefined' && window.electron) {
      if (authClearedCleanup) {
        authClearedCleanup();
        authClearedCleanup = null;
      }

      const cleanup = window.electron.on?.('auth:cleared', () => {
        logger.info('Desktop auth cleared event received, clearing session cache');
        onSessionCleared();
        onCSRFTokenCleared();
      });

      if (cleanup) {
        authClearedCleanup = cleanup;
      }

      initializePowerListeners(onSessionCleared);
    }

    if (isCapacitorApp() && getPlatform() === 'ios') {
      initializeIOSLifecycle(onSessionCleared, refreshSession).catch((err) => {
        logger.error('[iOS] Lifecycle setup failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  function initializePowerListeners(onSessionCleared: () => void): void {
    if (typeof window === 'undefined' || !window.electron?.power) return;

    powerEventCleanups.forEach(cleanup => cleanup());
    powerEventCleanups = [];

    const suspendCleanup = window.electron.power.onSuspend(({ suspendTime }) => {
      powerState = { isSuspended: true, suspendTime };
      logger.info('[Power] System suspended - pausing auth operations', { suspendTime });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('power:suspend', { detail: { suspendTime } }));
      }
    });
    powerEventCleanups.push(suspendCleanup);

    const resumeCleanup = window.electron.power.onResume(({ resumeTime, sleepDuration, forceRefresh }) => {
      const suspendedAt = powerState.suspendTime;
      powerState = { isSuspended: false, suspendTime: null };

      logger.info('[Power] System resumed - resuming auth operations', {
        resumeTime,
        sleepDuration,
        sleepDurationMin: Math.round(sleepDuration / 60000),
        forceRefresh,
      });

      onSessionCleared();

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('power:resume', {
          detail: { resumeTime, sleepDuration, forceRefresh, suspendedAt }
        }));
      }
    });
    powerEventCleanups.push(resumeCleanup);

    const unlockCleanup = window.electron.power.onUnlockScreen(({ shouldRefresh }) => {
      logger.debug('[Power] Screen unlocked', { shouldRefresh });

      if (shouldRefresh) {
        onSessionCleared();

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('power:unlock', { detail: { shouldRefresh } }));
        }
      }
    });
    powerEventCleanups.push(unlockCleanup);

    logger.info('[Power] Power state listeners initialized');
  }

  async function initializeIOSLifecycle(
    onSessionCleared: () => void,
    refreshSession: RefreshCallback
  ): Promise<void> {
    const capacitorApp = await import('@capacitor/app').catch(() => null);
    if (!capacitorApp) {
      logger.warn('[iOS] Failed to load @capacitor/app - skipping lifecycle setup');
      return;
    }
    const { App } = capacitorApp;
    let backgroundTime: number | null = null;

    App.addListener('appStateChange', async ({ isActive }: { isActive: boolean }) => {
      if (!isActive) {
        backgroundTime = Date.now();
        logger.debug('[iOS] App backgrounded', { time: backgroundTime });
      } else {
        const duration = backgroundTime ? Date.now() - backgroundTime : 0;
        backgroundTime = null;
        onSessionCleared();
        logger.debug('[iOS] App foregrounded', { backgroundDurationMs: duration });

        if (duration > 5 * 60 * 1000) {
          logger.info('[iOS] Long background period detected, refreshing session', {
            durationMin: Math.round(duration / 60000),
          });
          const result = await refreshSession();
          if (!result.success && result.shouldLogout) {
            window.dispatchEvent(new CustomEvent('auth:expired'));
          }
        }
      }
    });

    logger.info('[iOS] Lifecycle listeners initialized');
  }

  function getPowerState(): PowerState {
    return powerState;
  }

  function cleanup(): void {
    powerEventCleanups.forEach(cleanup => cleanup());
    powerEventCleanups = [];
    if (authClearedCleanup) {
      authClearedCleanup();
      authClearedCleanup = null;
    }
    initialized = false;
  }

  return { initialize, getPowerState, cleanup };
}
