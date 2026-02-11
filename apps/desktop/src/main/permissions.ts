const MEDIA_PERMISSIONS = new Set(['media', 'audioCapture', 'videoCapture']);

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isMediaPermission(permission: string): boolean {
  return MEDIA_PERMISSIONS.has(permission);
}

export function isTrustedMediaOrigin(requestingUrl: string | null | undefined, appUrl: string): boolean {
  const requestOrigin = normalizeOrigin(requestingUrl);
  const trustedOrigin = normalizeOrigin(appUrl);

  if (!requestOrigin || !trustedOrigin) {
    return false;
  }

  return requestOrigin === trustedOrigin;
}

export function shouldAllowMediaPermission(
  permission: string,
  requestingUrl: string | null | undefined,
  appUrl: string
): boolean {
  if (!isMediaPermission(permission)) {
    return false;
  }

  return isTrustedMediaOrigin(requestingUrl, appUrl);
}
