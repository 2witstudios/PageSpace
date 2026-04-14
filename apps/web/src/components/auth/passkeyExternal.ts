export interface PasskeyExternalDeviceFields {
  deviceId: string;
  deviceName: string;
}

const PASSKEY_EXTERNAL_PATH = '/auth/passkey-external';

export function buildPasskeyExternalUrl(
  origin: string,
  { deviceId, deviceName }: PasskeyExternalDeviceFields,
): string {
  const url = new URL(PASSKEY_EXTERNAL_PATH, origin);
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('deviceName', deviceName);
  return url.toString();
}

export function buildPasskeyExchangeDeepLink(exchangeCode: string): string {
  const url = new URL('pagespace://auth-exchange');
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
  return { deviceId, deviceName };
}
