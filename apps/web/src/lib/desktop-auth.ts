/**
 * Desktop Auth Utilities
 *
 * Client-side helpers for storing auth tokens on the Electron desktop app
 * via the IPC bridge. Used by auth components after successful authentication.
 */

export interface DesktopAuthTokens {
  sessionToken: string;
  csrfToken: string;
  deviceToken: string;
}

export function isDesktopPlatform(): boolean {
  return typeof window !== 'undefined' && !!window.electron?.isDesktop;
}

export async function getDesktopDeviceInfo(): Promise<{
  deviceId: string;
  deviceName: string;
} | null> {
  if (!isDesktopPlatform()) return null;
  const info = await window.electron!.auth.getDeviceInfo();
  return { deviceId: info.deviceId, deviceName: info.deviceName };
}

/**
 * Returns platform fields to spread into a request body.
 * On web, returns empty object. On desktop, returns { platform, deviceId, deviceName }.
 */
export async function getDevicePlatformFields(): Promise<
  { platform: 'desktop'; deviceId: string; deviceName: string } | Record<string, never>
> {
  const info = await getDesktopDeviceInfo();
  if (!info) return {};
  return { platform: 'desktop', deviceId: info.deviceId, deviceName: info.deviceName };
}

/**
 * Store auth tokens via the Electron IPC bridge.
 * Throws if not running on desktop.
 */
export async function handleDesktopAuthTokens(tokens: DesktopAuthTokens): Promise<void> {
  if (!isDesktopPlatform()) {
    throw new Error('Desktop auth bridge not available');
  }
  await window.electron!.auth.storeSession({
    sessionToken: tokens.sessionToken,
    csrfToken: tokens.csrfToken,
    deviceToken: tokens.deviceToken,
  });
}

/**
 * If on desktop and response contains auth tokens, store them and redirect.
 * Reads tokens from top-level response fields (sessionToken, csrfToken, deviceToken).
 * Returns true if handled (caller should return), false otherwise.
 */
export async function handleDesktopAuthResponse(
  data: { sessionToken?: string; csrfToken?: string; deviceToken?: string; redirectUrl?: string },
  fallbackUrl = '/dashboard',
): Promise<boolean> {
  if (!isDesktopPlatform()) return false;
  if (!data.sessionToken || !data.csrfToken || !data.deviceToken) return false;
  await handleDesktopAuthTokens({
    sessionToken: data.sessionToken,
    csrfToken: data.csrfToken,
    deviceToken: data.deviceToken,
  });
  window.location.href = data.redirectUrl || fallbackUrl;
  return true;
}
