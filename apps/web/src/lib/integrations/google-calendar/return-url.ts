const DEFAULT_RETURN_PATH = '/settings/integrations/google-calendar';

/**
 * Normalize and validate a user-provided return path.
 * Only relative in-app paths are allowed to prevent open redirects.
 */
export function normalizeGoogleCalendarReturnPath(returnUrl?: string | null): string {
  if (!returnUrl || typeof returnUrl !== 'string') {
    return DEFAULT_RETURN_PATH;
  }

  const trimmed = returnUrl.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return DEFAULT_RETURN_PATH;
  }

  try {
    const parsed = new URL(trimmed, 'http://localhost');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}

export { DEFAULT_RETURN_PATH as GOOGLE_CALENDAR_DEFAULT_RETURN_PATH };
