/**
 * Light-touch CSS sanitization for canvas pages
 * Goal: Allow creative freedom while blocking JavaScript execution
 */
export function sanitizeCSS(css: string): string {
  if (!css) return '';

  return css
    // Remove JavaScript execution vectors
    .replace(/expression\s*\(/gi, '/* expression blocked */')
    .replace(/-moz-binding\s*:/gi, '/* moz-binding blocked */')
    .replace(/javascript:/gi, '/* javascript blocked */')
    .replace(/behavior\s*:/gi, '/* behavior blocked */')

    // Block external imports (prevent data exfiltration)
    .replace(/@import\s+url\s*\(['"]?(?!data:)[^'")]+['"]?\)/gi, '/* @import blocked */')
    .replace(/@import\s+['"](?!data:)[^'"]+['"]/gi, '/* @import blocked */')

    // Allow data URIs for images/fonts (they're safe and useful)
    // Allow all other CSS - users should have creative freedom
    // This includes animations, transforms, gradients, custom properties, etc.
    ;
}