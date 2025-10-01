/**
 * CSS Sanitization for Canvas Pages - SECURITY HARDENED VERSION
 *
 * Blocks external resource loading while preserving creative freedom.
 * Protects against data exfiltration via url() tracking pixels.
 *
 * @see /Users/jono/production/PageSpace/CSS_URL_EXFILTRATION_ANALYSIS.md
 */

/**
 * Sanitizes CSS to prevent JavaScript execution and data exfiltration
 *
 * BLOCKS:
 * - JavaScript execution vectors (expression, behavior, javascript:)
 * - External @import statements
 * - External url() references (http://, https://, //, blob:, file:)
 *
 * ALLOWS:
 * - data: URIs for images and fonts
 * - All other CSS (gradients, transforms, animations, variables)
 *
 * @param css - Raw CSS string from canvas page
 * @returns Sanitized CSS safe for Shadow DOM injection
 */
export function sanitizeCSS(css: string): string {
  if (!css) return '';

  let sanitized = css;

  // 1. Remove JavaScript execution vectors
  sanitized = sanitized
    .replace(/expression\s*\(/gi, '/* expression() blocked */')
    .replace(/-moz-binding\s*:/gi, '/* -moz-binding blocked */')
    .replace(/javascript:/gi, '/* javascript: blocked */')
    .replace(/behavior\s*:/gi, '/* behavior blocked */');

  // 2. Block external @import statements
  // Matches: @import url("...") or @import "..."
  // Allows: @import url("data:...")
  sanitized = sanitized
    .replace(/@import\s+url\s*\(\s*(['"]?)(?!data:)([^'")]+)\1\s*\)/gi, '/* @import url() blocked */')
    .replace(/@import\s+(['"])(?!data:)([^'"]+)\1/gi, '/* @import blocked */');

  // 3. Block external url() functions (CRITICAL FIX for data exfiltration)
  // Matches: url("https://...") or url('http://...') or url(//evil.com)
  // Allows: url("data:image/...") and url("data:font/...")
  sanitized = sanitized.replace(
    /url\s*\(\s*(['"]?)(?!data:)([^'")]+)\1\s*\)/gi,
    (match, quote, url) => {
      // Trim whitespace for clean logging
      const trimmedUrl = url.trim();

      // Only log non-empty URLs (avoid logging url("") replacements)
      if (trimmedUrl && trimmedUrl.length > 0) {
        console.warn(
          `[Canvas Security] Blocked external URL in CSS:`,
          trimmedUrl.substring(0, 100)
        );
      }

      // Replace with empty URL (safe fallback)
      return 'url("")';
    }
  );

  // 4. Validate data: URIs are properly formed (defense in depth)
  // Only allow image/* and font/* MIME types
  // This prevents potential data:text/html attacks (browsers already block these in CSS)
  sanitized = sanitized.replace(
    /url\s*\(\s*(['"]?)(data:([^'")]+))\1\s*\)/gi,
    (match, quote, dataUrl, mimeType) => {
      // Extract MIME type from data URI (format: data:TYPE/SUBTYPE;...)
      const lowercaseMime = mimeType.toLowerCase();

      // Allow image and font data URIs
      if (lowercaseMime.startsWith('image/') || lowercaseMime.startsWith('font/')) {
        return match; // Keep as-is
      }

      // Block unexpected MIME types
      console.warn(
        `[Canvas Security] Blocked non-image/font data URI:`,
        mimeType.substring(0, 50)
      );
      return 'url("")';
    }
  );

  return sanitized;
}

/**
 * Test suite for CSS sanitization
 * Run this to verify all security controls are working
 *
 * @returns true if all tests pass
 */
export function testCSSSanitization(): boolean {
  const tests = [
    // ===== SHOULD BLOCK EXTERNAL URLs =====
    {
      input: "background: url('https://evil.com/track.gif');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block HTTPS background image with single quotes'
    },
    {
      input: 'background: url("https://evil.com/track.gif");',
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block HTTPS background image with double quotes'
    },
    {
      input: "background: url(http://evil.com/track.gif);",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block HTTP background image without quotes'
    },
    {
      input: "background: url('//evil.com/track.gif');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block protocol-relative URL'
    },
    {
      input: "cursor: url('https://evil.com/cursor.png'), pointer;",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block cursor tracking pixel'
    },
    {
      input: "@font-face { src: url('https://evil.com/font.woff2'); }",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block external font loading'
    },
    {
      input: "filter: url('https://evil.com/filter.svg#blur');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block SVG filter reference'
    },
    {
      input: "mask-image: url('https://evil.com/mask.svg');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block mask image tracking'
    },
    {
      input: "border-image: url('https://evil.com/border.png');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block border image tracking'
    },
    {
      input: "list-style-image: url('https://evil.com/bullet.png');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block list style image'
    },
    {
      input: "content: url('https://evil.com/content.svg');",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block content property URL'
    },
    {
      input: "background: url(https://evil.com/track.gif);", // No quotes
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block unquoted HTTPS URL'
    },
    {
      input: "background: url(  'https://evil.com/track.gif'  );", // Extra whitespace
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block URL with extra whitespace'
    },
    {
      input: "background: url('blob:https://localhost:3000/abc-123');",
      shouldContain: 'url("")',
      shouldNotContain: 'blob:',
      description: 'Block blob: URLs'
    },
    {
      input: "background: url('file:///etc/passwd');",
      shouldContain: 'url("")',
      shouldNotContain: 'file:',
      description: 'Block file: URLs'
    },

    // ===== SHOULD ALLOW DATA URIs =====
    {
      input: "background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA');",
      shouldContain: 'data:image/png',
      shouldNotContain: 'url("")',
      description: 'Allow PNG data URI'
    },
    {
      input: "background: url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3C/svg%3E);",
      shouldContain: 'data:image/svg',
      shouldNotContain: 'url("")',
      description: 'Allow SVG data URI without quotes'
    },
    {
      input: '@font-face { src: url("data:font/woff2;base64,ABC123"); }',
      shouldContain: 'data:font/woff2',
      shouldNotContain: 'url("")',
      description: 'Allow WOFF2 font data URI'
    },
    {
      input: "cursor: url('data:image/png;base64,iVBORw0KGg'), pointer;",
      shouldContain: 'data:image/png',
      shouldNotContain: 'url("")',
      description: 'Allow cursor image data URI'
    },
    {
      input: "mask-image: url('data:image/svg+xml;utf8,<svg></svg>');",
      shouldContain: 'data:image/svg',
      shouldNotContain: 'url("")',
      description: 'Allow SVG mask data URI'
    },

    // ===== SHOULD BLOCK NON-IMAGE/FONT DATA URIs =====
    {
      input: "background: url('data:text/html,<script>alert(1)</script>');",
      shouldContain: 'url("")',
      shouldNotContain: 'text/html',
      description: 'Block HTML data URI'
    },
    {
      input: "background: url('data:application/javascript,alert(1)');",
      shouldContain: 'url("")',
      shouldNotContain: 'javascript',
      description: 'Block JavaScript data URI'
    },

    // ===== SHOULD PRESERVE OTHER CSS =====
    {
      input: "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);",
      shouldContain: 'linear-gradient',
      shouldNotContain: 'url("")',
      description: 'Preserve linear gradient'
    },
    {
      input: "background: radial-gradient(circle, red, blue);",
      shouldContain: 'radial-gradient',
      shouldNotContain: 'url("")',
      description: 'Preserve radial gradient'
    },
    {
      input: "background: conic-gradient(from 90deg, red, yellow, green);",
      shouldContain: 'conic-gradient',
      shouldNotContain: 'url("")',
      description: 'Preserve conic gradient'
    },
    {
      input: "background: #667eea;",
      shouldContain: '#667eea',
      shouldNotContain: 'url("")',
      description: 'Preserve hex color'
    },
    {
      input: "transform: rotate(45deg) scale(1.5);",
      shouldContain: 'rotate(45deg)',
      shouldNotContain: 'url("")',
      description: 'Preserve transform functions'
    },
    {
      input: "animation: fadeIn 1s ease-in-out;",
      shouldContain: 'fadeIn',
      shouldNotContain: 'url("")',
      description: 'Preserve animation'
    },
    {
      input: "--custom-color: #667eea;",
      shouldContain: '--custom-color',
      shouldNotContain: 'url("")',
      description: 'Preserve CSS variables'
    },
    {
      input: "filter: blur(5px) brightness(1.2);",
      shouldContain: 'blur(5px)',
      shouldNotContain: 'url("")',
      description: 'Preserve filter functions'
    },

    // ===== SHOULD BLOCK JAVASCRIPT EXECUTION =====
    {
      input: "width: expression(alert('XSS'));",
      shouldContain: 'blocked',
      shouldNotContain: 'expression(alert',
      description: 'Block CSS expression()'
    },
    {
      input: "background: url(javascript:alert('XSS'));",
      shouldContain: 'blocked',
      shouldNotContain: 'javascript:alert',
      description: 'Block javascript: URL'
    },
    {
      input: "-moz-binding: url(xss.xml#xss);",
      shouldContain: 'blocked',
      shouldNotContain: '-moz-binding:',
      description: 'Block -moz-binding'
    },
    {
      input: "behavior: url(xss.htc);",
      shouldContain: 'blocked',
      shouldNotContain: 'behavior: url',
      description: 'Block IE behavior'
    },

    // ===== SHOULD BLOCK @IMPORT =====
    {
      input: "@import url('https://evil.com/style.css');",
      shouldContain: 'blocked',
      shouldNotContain: 'evil.com',
      description: 'Block @import with url()'
    },
    {
      input: '@import "https://evil.com/style.css";',
      shouldContain: 'blocked',
      shouldNotContain: 'evil.com',
      description: 'Block @import without url()'
    },
    {
      input: "@import url('data:text/css,body{color:red}');",
      shouldContain: 'data:text/css',
      shouldNotContain: 'blocked',
      description: 'Allow @import with data URI'
    },

    // ===== EDGE CASES =====
    {
      input: "background: url('https://evil.com/1'), url('data:image/png;base64,ABC'), linear-gradient(red, blue);",
      shouldContain: 'data:image/png',
      shouldNotContain: 'evil.com',
      description: 'Mixed backgrounds - block external, keep data URI and gradient'
    },
    {
      input: ":root { --bg: url('https://evil.com/track.gif'); } .card { background: var(--bg); }",
      shouldContain: 'url("")',
      shouldNotContain: 'evil.com',
      description: 'Block external URL in CSS variable'
    },
    {
      input: "background: URL('HTTPS://EVIL.COM/TRACK.GIF');", // Uppercase
      shouldContain: 'url("")',
      shouldNotContain: 'EVIL.COM',
      description: 'Block uppercase URL and protocol'
    },
  ];

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const test of tests) {
    const result = sanitizeCSS(test.input);
    const containsPass = test.shouldContain ? result.includes(test.shouldContain) : true;
    const notContainsPass = test.shouldNotContain ? !result.includes(test.shouldNotContain) : true;

    if (containsPass && notContainsPass) {
      passed++;
      console.log(`✅ ${test.description}`);
    } else {
      failed++;
      const failureMsg = [
        `❌ ${test.description}`,
        `   Input:    ${test.input}`,
        `   Output:   ${result}`,
        `   Expected contains: ${test.shouldContain || 'N/A'}`,
        `   Expected NOT contains: ${test.shouldNotContain || 'N/A'}`,
      ].join('\n');

      console.error(failureMsg);
      failures.push(failureMsg);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}\n`);

  if (failures.length > 0) {
    console.error('FAILED TESTS:\n');
    failures.forEach(f => console.error(f + '\n'));
  }

  return failed === 0;
}

/**
 * Example usage and testing
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // Auto-run tests in development
  console.log('[Canvas CSS Sanitizer] Running test suite...\n');
  const allTestsPassed = testCSSSanitization();

  if (allTestsPassed) {
    console.log('🎉 All CSS sanitization tests passed!');
  } else {
    console.error('⚠️  Some CSS sanitization tests failed. Review above.');
  }
}
