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

