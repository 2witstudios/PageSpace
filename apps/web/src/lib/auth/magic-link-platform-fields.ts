import { getDesktopDeviceInfo } from '@/lib/desktop-auth';
import { getPlatform, isCapacitorApp } from '@/lib/capacitor-bridge';
import { getPlatformStorage } from '@/lib/auth/platform-storage';

/**
 * The device a magic link should be bound to, as the send route expects it.
 *
 * Desktop keeps its Electron device identity. The iOS / Android shell binds
 * the link to the same `deviceId` the native OAuth routes use (the one
 * `PlatformStorage.getDeviceId()` persists), so the in-app page that redeems
 * the universal link can prove it is the requesting device and receive
 * Keychain tokens. A browser sends nothing and gets a cookie session.
 *
 * Deliberately separate from `desktop-auth.getDevicePlatformFields()`: the
 * passkey routes that consume that helper accept only `web | desktop`, so
 * widening it there would 400 every passkey ceremony in the app.
 */
type MagicLinkPlatformFields =
  | { platform: 'desktop' | 'ios' | 'android'; deviceId: string; deviceName: string }
  | Record<string, never>;

const NATIVE_DEVICE_NAME = { ios: 'iOS App', android: 'Android App' } as const;

export async function getMagicLinkPlatformFields(): Promise<MagicLinkPlatformFields> {
  const desktop = await getDesktopDeviceInfo();
  if (desktop) {
    return { platform: 'desktop', deviceId: desktop.deviceId, deviceName: desktop.deviceName };
  }

  if (!isCapacitorApp()) return {};

  const platform = getPlatform();
  if (platform === 'web') return {};

  const deviceId = await getPlatformStorage().getDeviceId();
  return { platform, deviceId, deviceName: NATIVE_DEVICE_NAME[platform] };
}
