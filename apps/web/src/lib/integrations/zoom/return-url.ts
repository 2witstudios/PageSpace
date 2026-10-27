const DEFAULT_RETURN_PATH = '/settings/integrations/zoom';

export function normalizeZoomReturnPath(returnUrl?: string | null): string {
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

export { DEFAULT_RETURN_PATH as ZOOM_DEFAULT_RETURN_PATH };
