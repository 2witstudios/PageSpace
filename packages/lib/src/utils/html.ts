/**
 * Escape a string for safe interpolation into HTML text / attribute context.
 * Dependency-free so any module (canvas, forms, etc.) can import it without
 * coupling to another feature module.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
