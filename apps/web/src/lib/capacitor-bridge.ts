/**
 * Capacitor Bridge Utilities
 *
 * This module provides utilities for communicating between the web app
 * and the native Capacitor layer. It handles platform detection and
 * provides a safe way to call native functions.
 *
 * Platform detection has exactly one entry point — `getPlatform()`. Everything
 * else (including the capability table) is derived from it, so there is no
 * second path to `window.Capacitor` that can drift.
 */

export type Platform = 'ios' | 'android' | 'web';

/**
 * A native capability the shared web app may depend on.
 *
 * Call sites should ask "can this platform do X?" via {@link hasNativeCapability}
 * rather than "is this iOS?" — that keeps platform knowledge in the single table
 * below instead of scattering it across the app.
 */
export type NativeCapability = 'secureStore' | 'nativeAuth' | 'push' | 'badge';

/**
 * An identity provider that can be driven through a native SDK.
 *
 * `nativeAuth` is deliberately not a single boolean: Android has a native Google
 * sign-in SDK but no native Apple one — Apple sign-in on Android goes through
 * Apple's web flow — so provider support has to be modelled per platform.
 */
export type NativeAuthProvider = 'google' | 'apple';

/**
 * What each platform can actually do *today*.
 *
 * This table is the single source of truth. When a platform gains a capability,
 * flip the flag here and every consumer picks it up with no call-site change.
 */
const PLATFORM_CAPABILITIES: Record<
  Platform,
  Readonly<Record<NativeCapability, boolean>>
> = {
  // PageSpaceKeychain (Swift), @capgo/capacitor-social-login,
  // @capacitor/push-notifications, @capawesome/capacitor-badge.
  ios: Object.freeze({
    secureStore: true,
    nativeAuth: true,
    push: true,
    badge: true,
  }),
  // PageSpaceSecureStoragePlugin (registered in MainActivity.java as
  // "PageSpaceKeychain"), @capgo/capacitor-social-login (Google only),
  // Firebase Messaging via the Gradle build. The badge plugin is not yet in
  // apps/android/package.json.
  android: Object.freeze({
    secureStore: true,
    nativeAuth: true,
    push: true,
    badge: false,
  }),
  // A plain browser tab has none of these.
  web: Object.freeze({
    secureStore: false,
    nativeAuth: false,
    push: false,
    badge: false,
  }),
};

/** Which auth providers each platform can drive through a native SDK. */
const NATIVE_AUTH_PROVIDERS: Record<Platform, readonly NativeAuthProvider[]> = {
  ios: Object.freeze<NativeAuthProvider[]>(['google', 'apple']),
  // No native Android SDK for Sign in with Apple — that flow stays on the web.
  android: Object.freeze<NativeAuthProvider[]>(['google']),
  web: Object.freeze<NativeAuthProvider[]>([]),
};

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/**
 * Check if running in a native Capacitor app.
 */
export function isCapacitorApp(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  return typeof capacitor !== 'undefined' && !!capacitor.isNativePlatform?.();
}

const KNOWN_PLATFORMS: readonly Platform[] = ['ios', 'android', 'web'];

/**
 * Get the current platform.
 *
 * This is the module's only reader of `window.Capacitor` — every other helper
 * derives from it. Anything the shell reports that we don't have a row for
 * (a future Capacitor target) normalizes to 'web', so the declared return type
 * stays honest and capability lookups can never miss.
 */
export function getPlatform(): Platform {
  if (typeof window === 'undefined') return 'web';
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return 'web';
  const platform = capacitor.getPlatform?.();
  return KNOWN_PLATFORMS.find((known) => known === platform) ?? 'web';
}

/**
 * Check if running on iOS (native app).
 */
export function isIOS(): boolean {
  return getPlatform() === 'ios';
}

/**
 * Check if running on Android (native app).
 */
export function isAndroid(): boolean {
  return getPlatform() === 'android';
}

/**
 * Check if running inside any native Capacitor shell.
 *
 * Prefer this over `isIOS()` for anything that is not genuinely iOS-specific.
 *
 * This deliberately reflects the *shell*, not the capability-table key, so it
 * stays true on a native platform we have no capability row for (see
 * `getPlatform()`). "I am in a native app" and "we know what this platform can
 * do" are different questions: the first gates native-vs-browser behaviour, the
 * second is `hasNativeCapability()`. An unrecognized native platform is
 * therefore native with every capability unsupported — which is the safe
 * combination, and the reason capability checks must never be spelled as
 * `isNativeApp() && ...`.
 */
export function isNativeApp(): boolean {
  return isCapacitorApp();
}

/**
 * Check whether the current platform supports a native capability.
 *
 * Safe during SSR: `getPlatform()` returns 'web' when `window` is undefined,
 * so every capability reports unsupported rather than throwing.
 *
 * This is the non-React entry point, for modules like `auth-fetch` and
 * `platform-storage` that cannot call `useCapacitor()`. Components should
 * prefer `useCapacitor().capabilities`.
 *
 * @public Published API of the capability bridge. The call sites that consume
 * it (secure storage, push registration, badge sync) land in later leaves of
 * the Android parity epic, so knip cannot see a consumer yet.
 */
export function hasNativeCapability(capability: NativeCapability): boolean {
  return PLATFORM_CAPABILITIES[getPlatform()][capability];
}

/**
 * Get the full capability set for the current platform.
 *
 * Useful for hooks that expose capabilities as a single object. The returned
 * object is frozen — it is the shared table entry, not a copy.
 */
export function getNativeCapabilities(): Readonly<
  Record<NativeCapability, boolean>
> {
  return PLATFORM_CAPABILITIES[getPlatform()];
}

/**
 * Check whether a specific auth provider can be driven natively here.
 *
 * Note this is finer-grained than `hasNativeCapability('nativeAuth')`: Android
 * has nativeAuth but cannot drive Apple.
 *
 * @public Published API of the capability bridge. Its consumer is the native
 * auth module generalization leaf of the Android parity epic, so knip cannot
 * see a consumer yet.
 */
export function supportsNativeAuthProvider(
  provider: NativeAuthProvider
): boolean {
  return NATIVE_AUTH_PROVIDERS[getPlatform()].includes(provider);
}


/**
 * Inject platform information into the window object.
 * This allows the web app to detect the platform early.
 */
export function injectPlatformInfo(): void {
  if (typeof window !== 'undefined') {
    (window as Window & { __PAGESPACE_PLATFORM__?: Platform }).__PAGESPACE_PLATFORM__ =
      getPlatform();
  }
}

// Inject platform info on module load
if (typeof window !== 'undefined') {
  injectPlatformInfo();
}
