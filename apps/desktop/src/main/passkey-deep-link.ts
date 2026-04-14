export interface PasskeyDeepLinkDeps {
  focusWindow: () => void;
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export const PASSKEY_REGISTERED_HOST = 'passkey-registered';
export const PASSKEY_REGISTERED_CHANNEL = 'passkey:registered';

export function handlePasskeyRegistered(url: string, deps: PasskeyDeepLinkDeps): boolean {
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch (error) {
    deps.logger.warn('[Passkey Deep Link] Failed to parse URL', { error: String(error) });
    return false;
  }

  if (urlObj.host !== PASSKEY_REGISTERED_HOST) {
    return false;
  }

  deps.logger.info('[Passkey Deep Link] Received passkey-registered, focusing window');
  deps.focusWindow();
  deps.sendToRenderer(PASSKEY_REGISTERED_CHANNEL);
  return true;
}
