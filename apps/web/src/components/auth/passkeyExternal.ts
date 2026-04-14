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

export interface PasskeyRegisterExternalFields {
  deviceId: string;
  deviceName: string;
  handoffToken: string;
}

const PASSKEY_REGISTER_EXTERNAL_PATH = '/auth/passkey-register-external';
const PASSKEY_REGISTERED_DEEP_LINK = 'pagespace://passkey-registered';

export function buildPasskeyRegisterExternalUrl(
  origin: string,
  { deviceId, deviceName, handoffToken }: PasskeyRegisterExternalFields,
): string {
  const url = new URL(PASSKEY_REGISTER_EXTERNAL_PATH, origin);
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('deviceName', deviceName);
  url.searchParams.set('handoffToken', handoffToken);
  return url.toString();
}

export function parsePasskeyRegisterExternalParams(
  search: string,
): PasskeyRegisterExternalFields | null {
  const params = new URLSearchParams(search);
  const deviceId = params.get('deviceId');
  const deviceName = params.get('deviceName');
  const handoffToken = params.get('handoffToken');
  if (!deviceId || !deviceName || !handoffToken) return null;
  return { deviceId, deviceName, handoffToken };
}

export function buildPasskeyRegisteredDeepLink(): string {
  return PASSKEY_REGISTERED_DEEP_LINK;
}
