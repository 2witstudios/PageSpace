import { describe, it, expect } from 'vitest'
import { sanitizeCSS } from '../sanitize-css'

describe('sanitizeCSS — allowedHttpsHosts option', () => {
  it('given allowedHttpsHosts containing the url host, should preserve the url() unchanged', () => {
    const css = 'background: url("https://assets.pagespace.ai/assets/abc123");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: ['assets.pagespace.ai'] })
    expect(result).toContain('https://assets.pagespace.ai/assets/abc123')
    expect(result).not.toContain('url("")')
  })

  it('given an allowed HTTPS URL with uppercase host and explicit port, should preserve it', () => {
    const css = 'background: url("https://ASSETS.PAGESPACE.AI:443/assets/abc123");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: ['assets.pagespace.ai'] })
    expect(result).toContain('https://ASSETS.PAGESPACE.AI:443/assets/abc123')
    expect(result).not.toContain('url("")')
  })

  it('given allowedHttpsHosts with uppercase host and port, should normalize before matching', () => {
    const css = 'background: url("https://assets.pagespace.ai/assets/abc123");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: ['ASSETS.PAGESPACE.AI:443'] })
    expect(result).toContain('https://assets.pagespace.ai/assets/abc123')
    expect(result).not.toContain('url("")')
  })

  it('given allowedHttpsHosts set but url host does not match, should still replace with url("")', () => {
    const css = 'background: url("https://evil.com/pixel.png");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: ['assets.pagespace.ai'] })
    expect(result).not.toContain('evil.com')
    expect(result).toContain('url("")')
  })

  it('given allowedHttpsHosts: [] (empty), should replace any HTTPS url() with url("")', () => {
    const css = 'background: url("https://assets.pagespace.ai/x.png");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: [] })
    expect(result).not.toContain('assets.pagespace.ai')
    expect(result).toContain('url("")')
  })

  it('given url uses HTTP (not HTTPS), should replace with url("") even if host is in allowedHttpsHosts', () => {
    const css = 'background: url("http://assets.pagespace.ai/x.png");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: ['assets.pagespace.ai'] })
    expect(result).not.toContain('http://assets.pagespace.ai')
    expect(result).toContain('url("")')
  })

  it('given the host appears as a substring of another host, should not allow it through', () => {
    // 'pagespace.ai' in allowlist must NOT allow 'evil-pagespace.ai'
    const css = 'background: url("https://evil-pagespace.ai/x.png");'
    const result = sanitizeCSS(css, { allowedHttpsHosts: ['pagespace.ai'] })
    expect(result).not.toContain('evil-pagespace.ai')
    expect(result).toContain('url("")')
  })

  it('given no opts argument, should block all external HTTPS url() values (existing default)', () => {
    const css = 'background: url("https://assets.pagespace.ai/x.png");'
    const result = sanitizeCSS(css)
    expect(result).not.toContain('assets.pagespace.ai')
    expect(result).toContain('url("")')
  })
})

describe('sanitizeCSS — allowAnyHttpsUrl option (site mode)', () => {
  it('given allowAnyHttpsUrl, should preserve an https url() from any host', () => {
    const css = 'background: url("https://cdn.example.com/hero.png");'
    const result = sanitizeCSS(css, { allowAnyHttpsUrl: true })
    expect(result).toContain('https://cdn.example.com/hero.png')
    expect(result).not.toContain('url("")')
  })

  it('given allowAnyHttpsUrl, should preserve an https @import so webfont stylesheets load', () => {
    const css = "@import url('https://fonts.googleapis.com/css2?family=Inter');"
    const result = sanitizeCSS(css, { allowAnyHttpsUrl: true })
    expect(result).toContain('fonts.googleapis.com')
    expect(result).not.toContain('@import blocked')
  })

  it('given allowAnyHttpsUrl, should still block script execution vectors', () => {
    const css = 'a { width: expression(alert(1)); background: url("javascript:alert(1)"); }'
    const result = sanitizeCSS(css, { allowAnyHttpsUrl: true })
    expect(result).toContain('expression blocked')
    expect(result).toContain('javascript blocked')
  })

  it('given allowAnyHttpsUrl, should still neuter the data:text/html scheme', () => {
    const css = 'background: url("data:text/html,<script>alert(1)</script>");'
    const result = sanitizeCSS(css, { allowAnyHttpsUrl: true })
    // What makes this dangerous is the scheme sitting in a fetchable position.
    // Once it is replaced by a comment marker the browser has no document to
    // parse, and the leftover markup text is inert.
    expect(result).not.toMatch(/url\(\s*['"]?data:text\/html/i)
    expect(result).toContain('data:text/html blocked')
  })

  it('given allowAnyHttpsUrl, should still block plaintext http:// so a site cannot downgrade', () => {
    const css = 'background: url("http://cdn.example.com/hero.png");'
    const result = sanitizeCSS(css, { allowAnyHttpsUrl: true })
    expect(result).toContain('url("")')
  })

  it('given allowAnyHttpsUrl is absent, should block external https exactly as before', () => {
    const css = 'background: url("https://cdn.example.com/hero.png");'
    expect(sanitizeCSS(css)).toContain('url("")')
    expect(sanitizeCSS(css, { allowAnyHttpsUrl: false })).toContain('url("")')
  })
})

describe('sanitizeCSS', () => {
  it('given empty input, should return an empty string', () => {
    expect(sanitizeCSS('')).toBe('')
  })

  describe('blocks JavaScript execution vectors', () => {
    it('given an expression(), should block it', () => {
      const result = sanitizeCSS('width: expression(alert(1));')
      expect(result).not.toContain('expression(')
      expect(result).toContain('/* expression blocked */')
    })

    it('given a bare javascript: scheme, should block it', () => {
      const result = sanitizeCSS('content: javascript:alert(1);')
      expect(result.toLowerCase()).not.toContain('javascript:')
      expect(result).toContain('/* javascript blocked */')
    })

    it('given a javascript: scheme inside url(), should neutralize it to an empty url', () => {
      const result = sanitizeCSS('background: url(javascript:alert(1));')
      expect(result.toLowerCase()).not.toContain('javascript:')
      expect(result).toContain('url("")')
    })

    it('given -moz-binding, should block it', () => {
      const result = sanitizeCSS('-moz-binding: url("evil.xml#x");')
      expect(result.toLowerCase()).not.toContain('-moz-binding:')
      expect(result).toContain('/* moz-binding blocked */')
    })

    it('given a behavior: property, should block it', () => {
      const result = sanitizeCSS('behavior: url(evil.htc);')
      expect(result.toLowerCase()).not.toContain('behavior:')
      expect(result).toContain('/* behavior blocked */')
    })

    it('given scroll-behavior: smooth, should NOT corrupt it as a blocked behavior', () => {
      const result = sanitizeCSS('html { scroll-behavior: smooth; }')
      expect(result).toContain('scroll-behavior: smooth')
      expect(result).not.toContain('/* behavior blocked */')
    })

    it('given overscroll-behavior: contain, should NOT corrupt it as a blocked behavior', () => {
      const result = sanitizeCSS('.x { overscroll-behavior: contain; }')
      expect(result).toContain('overscroll-behavior: contain')
      expect(result).not.toContain('/* behavior blocked */')
    })
  })

  describe('blocks external resource loading', () => {
    it('given an external @import url(), should block it', () => {
      const result = sanitizeCSS('@import url("https://evil.com/track.css");')
      expect(result).not.toContain('https://evil.com')
      expect(result).toContain('/* @import blocked */')
    })

    it('given an external @import string, should block it', () => {
      const result = sanitizeCSS('@import "https://evil.com/track.css";')
      expect(result).not.toContain('https://evil.com')
      expect(result).toContain('/* @import blocked */')
    })

    it('given an external url(), should replace it with an empty url', () => {
      const result = sanitizeCSS('background: url("https://evil.com/pixel.png");')
      expect(result).not.toContain('https://evil.com')
      expect(result).toContain('url("")')
    })

    it('given a bare data:text/html scheme, should block it', () => {
      const result = sanitizeCSS('content: data:text/html,<x>;')
      expect(result).toContain('/* data:text/html blocked */')
    })

    it('given a data:text/html url(), should neutralize it to an empty url', () => {
      const result = sanitizeCSS('background: url("data:text/html;base64,PHNjcmlwdD4=");')
      expect(result.toLowerCase()).not.toContain('data:text/html')
      expect(result).toContain('url("")')
    })
  })

  describe('preserves safe creative CSS', () => {
    it('given a linear gradient, should preserve it', () => {
      const css = 'background: linear-gradient(45deg, #fff, #000);'
      expect(sanitizeCSS(css)).toBe(css)
    })

    it('given a transform, should preserve it', () => {
      const css = 'transform: rotate(45deg) scale(1.2);'
      expect(sanitizeCSS(css)).toBe(css)
    })

    it('given CSS variables, should preserve them', () => {
      const css = ':root { --brand: #ff0000; } .x { color: var(--brand); }'
      expect(sanitizeCSS(css)).toBe(css)
    })

    it('given a data:image url(), should preserve it', () => {
      const css = 'background: url("data:image/png;base64,iVBORw0KGgo=");'
      expect(sanitizeCSS(css)).toBe(css)
    })

    it('given a data:font url(), should preserve it', () => {
      const css = "src: url('data:font/woff2;base64,d09GMgAB');"
      expect(sanitizeCSS(css)).toBe(css)
    })
  })
})
