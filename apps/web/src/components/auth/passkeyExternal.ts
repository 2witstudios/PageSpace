import { currentDesktopShell, desktopDeepLink, parseDesktopShell, type DesktopShell } from '@/lib/auth/desktop-shell';

/**
 * These handoffs run in the SYSTEM BROWSER, where the preload bridge is absent,
 * so the desktop app cannot be asked which shell it is. The variant has to ride
 * the handoff URL — otherwise a passkey ceremony started in PageSpace Coder
 * would deep-link its exchange code into PageSpace.
 */
export interface PasskeyExternalDeviceFields {
  deviceId: string;
  deviceName: string;
  shell?: DesktopShell;
}

const PASSKEY_EXTERNAL_PATH = '/auth/passkey-external';

export function buildPasskeyExternalUrl(
  origin: string,
  { deviceId, deviceName, shell = currentDesktopShell() }: PasskeyExternalDeviceFields,
): string {
  const url = new URL(PASSKEY_EXTERNAL_PATH, origin);
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('deviceName', deviceName);
  if (shell) url.searchParams.set('shell', shell);
  return url.toString();
}

export function buildPasskeyExchangeDeepLink(exchangeCode: string, shell?: unknown): string {
  const url = new URL(desktopDeepLink(shell, 'auth-exchange'));
  url.searchParams.set('code', exchangeCode);
  url.searchParams.set('provider', 'passkey');
  return url.toString();
}

export function parsePasskeyExternalParams(
  search: string,
): PasskeyExternalDeviceFields | null {
  const params = new URLSearchParams(search);
  const deviceId = params.get('deviceId');
  const deviceName = params.get('deviceName');
  if (!deviceId || !deviceName) return null;
  return { deviceId, deviceName, shell: parseDesktopShell(params.get('shell')) };
}

export interface PasskeyRegisterExternalFields {
  deviceId: string;
  deviceName: string;
  handoffToken: string;
  shell?: DesktopShell;
}

const PASSKEY_REGISTER_EXTERNAL_PATH = '/auth/passkey-register-external';

/**
 * Builds the external-browser handoff URL. The `handoffToken` is carried in
 * the URL fragment so it never touches the network, server access logs, CDN
 * logs, the browser's Referer header, or same-origin fetches. `deviceId` and
 * `deviceName` stay in the query since they are not capability-bearing.
 */
export function buildPasskeyRegisterExternalUrl(
  origin: string,
  { deviceId, deviceName, handoffToken, shell = currentDesktopShell() }: PasskeyRegisterExternalFields,
): string {
  const url = new URL(PASSKEY_REGISTER_EXTERNAL_PATH, origin);
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('deviceName', deviceName);
  if (shell) url.searchParams.set('shell', shell);
  const fragment = new URLSearchParams({ handoffToken });
  url.hash = fragment.toString();
  return url.toString();
}

export function parsePasskeyRegisterExternalParams(
  search: string,
  hash = '',
): PasskeyRegisterExternalFields | null {
  const params = new URLSearchParams(search);
  const deviceId = params.get('deviceId');
  const deviceName = params.get('deviceName');
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const handoffToken = fragment.get('handoffToken');
  if (!deviceId || !deviceName || !handoffToken) return null;
  return { deviceId, deviceName, handoffToken, shell: parseDesktopShell(params.get('shell')) };
}

export function buildPasskeyRegisteredDeepLink(shell?: unknown): string {
  return desktopDeepLink(shell, 'passkey-registered');
}
