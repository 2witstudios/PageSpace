import type { PlatformStorage } from './types';
import { hasNativeCapability, getPlatform, type Platform } from '@/lib/capacitor-bridge';
/**
 * These were `require()` calls so a platform's module only loaded on that
 * platform. They are static imports now: every one of these modules already
 * defers its platform-specific dependency (`@/lib/keychain-plugin`,
 * `@/lib/ios-google-auth`, `@capacitor/preferences`, `window.electron`) to a
 * dynamic import *inside* a method, so their module bodies carry nothing but
 * `cuid2` — which `web-storage` pulls in on every platform regardless. The
 * requires bought no code splitting and cost the factory its testability:
 * `require` of a TypeScript module does not resolve under vitest, so nothing
 * could assert which implementation a platform actually resolves to.
 */
import { AndroidStorage } from './android-storage';
import { DesktopStorage } from './desktop-storage';
import { IOSStorage } from './ios-storage';
import { WebStorage } from './web-storage';

export * from './types';

let instance: PlatformStorage | null = null;

/**
 * How each platform builds its secure-storage implementation.
 *
 * Table-driven rather than a chain of `getPlatform() === '<os>'` tests, so
 * adding a platform is a row here plus a flag in the capability table — the
 * whole point of `capacitor-bridge`. `web` is `null` because a browser tab has
 * no native store; `hasNativeCapability('secureStore')` already answers false
 * there, and the `null` row is what makes that agreement checkable by the
 * compiler instead of only at runtime.
 */
const SECURE_STORAGE_FACTORIES: Record<Platform, (() => PlatformStorage) | null> = {
  ios: () => new IOSStorage(),
  android: () => new AndroidStorage(),
  web: null,
};

/** The platform's storage adapter, built once and reused. */
export function getPlatformStorage(): PlatformStorage {
  if (instance) return instance;

  if (typeof window !== 'undefined') {
    const nativeStorage = hasNativeCapability('secureStore')
      ? SECURE_STORAGE_FACTORIES[getPlatform()]
      : null;

    if (window.electron?.isDesktop) {
      instance = new DesktopStorage();
    } else if (nativeStorage) {
      instance = nativeStorage();
    } else {
      instance = new WebStorage();
    }
  } else {
    instance = new WebStorage();
  }

  console.log(`[PlatformStorage] ${instance.platform}`);
  return instance;
}
