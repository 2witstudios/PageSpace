import { isCapacitorApp } from '@/hooks/useCapacitor';

export type HapticStyle = 'light' | 'medium' | 'heavy';

/**
 * Triggers haptic feedback on supported devices.
 * Uses Capacitor Haptics on native apps, falls back to Web Vibration API.
 */
export async function triggerHaptic(style: HapticStyle = 'medium'): Promise<void> {
  if (isCapacitorApp()) {
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      const styleMap = {
        light: ImpactStyle.Light,
        medium: ImpactStyle.Medium,
        heavy: ImpactStyle.Heavy,
      } as const;
      await Haptics.impact({ style: styleMap[style] });
    } catch {
      // Haptics not available, fail silently
    }
  } else if (typeof navigator !== 'undefined' && navigator.vibrate) {
    // Web fallback using Vibration API
    const durationMap: Record<HapticStyle, number> = {
      light: 10,
      medium: 25,
      heavy: 50,
    };
    navigator.vibrate(durationMap[style]);
  }
}

/**
 * Triggers a notification-style haptic feedback.
 * Used for success/warning/error states.
 */
export async function triggerNotificationHaptic(
  type: 'success' | 'warning' | 'error'
): Promise<void> {
  if (isCapacitorApp()) {
    try {
      const { Haptics, NotificationType } = await import('@capacitor/haptics');
      const typeMap = {
        success: NotificationType.Success,
        warning: NotificationType.Warning,
        error: NotificationType.Error,
      } as const;
      await Haptics.notification({ type: typeMap[type] });
    } catch {
      // Haptics not available, fail silently
    }
  } else if (typeof navigator !== 'undefined' && navigator.vibrate) {
    // Web fallback patterns
    const patternMap: Record<typeof type, number[]> = {
      success: [10, 50, 10],
      warning: [25, 25, 25],
      error: [50, 25, 50, 25, 50],
    };
    navigator.vibrate(patternMap[type]);
  }
}

/**
 * Triggers a selection-changed haptic feedback.
 * Lighter feedback suitable for UI interactions.
 */
export async function triggerSelectionHaptic(): Promise<void> {
  if (isCapacitorApp()) {
    try {
      const { Haptics } = await import('@capacitor/haptics');
      await Haptics.selectionStart();
      await Haptics.selectionEnd();
    } catch {
      // Haptics not available, fail silently
    }
  } else if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(5);
  }
}
