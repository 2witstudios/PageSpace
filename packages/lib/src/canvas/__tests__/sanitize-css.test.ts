import { describe, it, expect } from 'vitest'
import { sanitizeCSS } from '../sanitize-css'

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
