import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @/hooks/useCapacitor
vi.mock('@/hooks/useCapacitor', () => ({
  isCapacitorApp: vi.fn(),
}));

// Mock @capacitor/haptics — set up as a factory so we can control Haptics methods
vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: vi.fn().mockResolvedValue(undefined),
    notification: vi.fn().mockResolvedValue(undefined),
    selectionStart: vi.fn().mockResolvedValue(undefined),
    selectionEnd: vi.fn().mockResolvedValue(undefined),
  },
  ImpactStyle: {
    Light: 'LIGHT',
    Medium: 'MEDIUM',
    Heavy: 'HEAVY',
  },
  NotificationType: {
    Success: 'SUCCESS',
    Warning: 'WARNING',
    Error: 'ERROR',
  },
}));

import { isCapacitorApp } from '@/hooks/useCapacitor';
import { triggerHaptic, triggerNotificationHaptic, triggerSelectionHaptic } from '../haptics';

describe('haptics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerHaptic', () => {
    describe('when running in Capacitor native app', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
      });

      it('calls Haptics.impact with Medium style by default', async () => {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await triggerHaptic();
        expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Medium });
      });

      it('calls Haptics.impact with Light style for light haptic', async () => {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await triggerHaptic('light');
        expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Light });
      });

      it('calls Haptics.impact with Heavy style for heavy haptic', async () => {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await triggerHaptic('heavy');
        expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Heavy });
      });

      it('calls Haptics.impact with Medium style when explicitly passed', async () => {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await triggerHaptic('medium');
        expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Medium });
      });

      it('does not call navigator.vibrate', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerHaptic('light');
        expect(vibrateSpy).not.toHaveBeenCalled();
      });

      it('silently catches errors from Haptics plugin', async () => {
        const { Haptics } = await import('@capacitor/haptics');
        vi.mocked(Haptics.impact).mockRejectedValueOnce(new Error('Haptics unavailable'));
        await expect(triggerHaptic('medium')).resolves.toBeUndefined();
      });
    });

    describe('when running in web browser', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(false);
      });

      it('calls navigator.vibrate with 10ms for light style', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerHaptic('light');
        expect(vibrateSpy).toHaveBeenCalledWith(10);
      });

      it('calls navigator.vibrate with 25ms for medium style (default)', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerHaptic();
        expect(vibrateSpy).toHaveBeenCalledWith(25);
      });

      it('calls navigator.vibrate with 50ms for heavy style', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerHaptic('heavy');
        expect(vibrateSpy).toHaveBeenCalledWith(50);
      });

      it('does not throw when navigator.vibrate is not available', async () => {
        const originalVibrate = navigator.vibrate;
        // @ts-expect-error - testing undefined case
        navigator.vibrate = undefined;
        await expect(triggerHaptic('medium')).resolves.toBeUndefined();
        navigator.vibrate = originalVibrate;
      });
    });
  });

  describe('triggerNotificationHaptic', () => {
    describe('when running in Capacitor native app', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
      });

      it('calls Haptics.notification with Success type', async () => {
        const { Haptics, NotificationType } = await import('@capacitor/haptics');
        await triggerNotificationHaptic('success');
        expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Success });
      });

      it('calls Haptics.notification with Warning type', async () => {
        const { Haptics, NotificationType } = await import('@capacitor/haptics');
        await triggerNotificationHaptic('warning');
        expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Warning });
      });

      it('calls Haptics.notification with Error type', async () => {
        const { Haptics, NotificationType } = await import('@capacitor/haptics');
        await triggerNotificationHaptic('error');
        expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Error });
      });

      it('silently catches errors from Haptics plugin', async () => {
        const { Haptics } = await import('@capacitor/haptics');
        vi.mocked(Haptics.notification).mockRejectedValueOnce(new Error('Haptics unavailable'));
        await expect(triggerNotificationHaptic('success')).resolves.toBeUndefined();
      });
    });

    describe('when running in web browser', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(false);
      });

      it('calls navigator.vibrate with success pattern', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerNotificationHaptic('success');
        expect(vibrateSpy).toHaveBeenCalledWith([10, 50, 10]);
      });

      it('calls navigator.vibrate with warning pattern', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerNotificationHaptic('warning');
        expect(vibrateSpy).toHaveBeenCalledWith([25, 25, 25]);
      });

      it('calls navigator.vibrate with error pattern', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerNotificationHaptic('error');
        expect(vibrateSpy).toHaveBeenCalledWith([50, 25, 50, 25, 50]);
      });

      it('does not throw when navigator.vibrate is not available', async () => {
        const originalVibrate = navigator.vibrate;
        // @ts-expect-error - testing undefined case
        navigator.vibrate = undefined;
        await expect(triggerNotificationHaptic('success')).resolves.toBeUndefined();
        navigator.vibrate = originalVibrate;
      });
    });
  });

  describe('triggerSelectionHaptic', () => {
    describe('when running in Capacitor native app', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
      });

      it('calls Haptics.selectionStart and selectionEnd', async () => {
        const { Haptics } = await import('@capacitor/haptics');
        await triggerSelectionHaptic();
        expect(Haptics.selectionStart).toHaveBeenCalled();
        expect(Haptics.selectionEnd).toHaveBeenCalled();
      });

      it('silently catches errors from Haptics plugin', async () => {
        const { Haptics } = await import('@capacitor/haptics');
        vi.mocked(Haptics.selectionStart).mockRejectedValueOnce(new Error('Haptics unavailable'));
        await expect(triggerSelectionHaptic()).resolves.toBeUndefined();
      });
    });

    describe('when running in web browser', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(false);
      });

      it('calls navigator.vibrate with 5ms', async () => {
        const vibrateSpy = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
          value: vibrateSpy,
          writable: true,
          configurable: true,
        });
        await triggerSelectionHaptic();
        expect(vibrateSpy).toHaveBeenCalledWith(5);
      });

      it('does not throw when navigator.vibrate is not available', async () => {
        const originalVibrate = navigator.vibrate;
        // @ts-expect-error - testing undefined case
        navigator.vibrate = undefined;
        await expect(triggerSelectionHaptic()).resolves.toBeUndefined();
        navigator.vibrate = originalVibrate;
      });
    });
  });
});
