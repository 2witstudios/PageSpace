/**
 * Validate and reconstruct a URL for safe use as an iframe src.
 * Only allows http, https, and blob protocols. Reconstructs via parsed URL
 * to break taint chain and prevent XSS.
 */
export function sanitizeIframeSrc(rawSrc: string | undefined): string {
  if (!rawSrc) return '';
  try {
    const parsed = new URL(rawSrc, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'blob:') {
      return parsed.href;
    }
    return '';
  } catch {
    return '';
  }
}
