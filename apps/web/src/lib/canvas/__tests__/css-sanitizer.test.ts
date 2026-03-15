import { describe, it, expect, vi } from 'vitest';
import { sanitizeCSS } from '../css-sanitizer';

describe('css-sanitizer', () => {
  describe('sanitizeCSS', () => {
    it('should return empty string for empty input', () => {
      expect(sanitizeCSS('')).toBe('');
    });

    it('should return empty string for falsy input', () => {
      expect(sanitizeCSS(null as unknown as string)).toBe('');
    });

    it('should pass through normal CSS', () => {
      const css = 'body { color: red; font-size: 16px; }';
      expect(sanitizeCSS(css)).toBe(css);
    });

    it('should pass through gradients', () => {
      const css = 'background: linear-gradient(to right, red, blue);';
      expect(sanitizeCSS(css)).toBe(css);
    });

    it('should pass through CSS variables', () => {
      const css = 'color: var(--primary-color);';
      expect(sanitizeCSS(css)).toBe(css);
    });

    it('should pass through animations', () => {
      const css = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
      expect(sanitizeCSS(css)).toBe(css);
    });

    it('should block expression()', () => {
      const css = 'width: expression(document.body.clientWidth / 2)';
      expect(sanitizeCSS(css)).toContain('/* expression blocked */');
    });

    it('should block -moz-binding', () => {
      const css = '-moz-binding: url("http://evil.com/xbl.xml")';
      expect(sanitizeCSS(css)).toContain('/* moz-binding blocked */');
    });

    it('should block javascript: URLs', () => {
      const css = 'background: javascript:alert(1)';
      expect(sanitizeCSS(css)).toContain('/* javascript blocked */');
    });

    it('should block vbscript: URLs', () => {
      const css = 'background: vbscript:msgbox';
      expect(sanitizeCSS(css)).toContain('/* vbscript blocked */');
    });

    it('should block data:text/html', () => {
      const css = 'background: data:text/html,<script>alert(1)</script>';
      expect(sanitizeCSS(css)).toContain('/* data:text/html blocked */');
    });

    it('should block behavior:', () => {
      const css = 'behavior: url("evil.htc")';
      expect(sanitizeCSS(css)).toContain('/* behavior blocked */');
    });

    it('should block external @import with url()', () => {
      const css = '@import url("https://evil.com/styles.css")';
      expect(sanitizeCSS(css)).toContain('/* @import blocked */');
    });

    it('should block external @import with string', () => {
      const css = '@import "https://evil.com/styles.css"';
      expect(sanitizeCSS(css)).toContain('/* @import blocked */');
    });

    it('should block external URLs in url()', () => {
      const css = 'background: url("https://tracking.evil.com/pixel.gif")';
      expect(sanitizeCSS(css)).toContain('url("")');
    });

    it('should allow data: image URIs', () => {
      const css = 'background: url("data:image/png;base64,abc123")';
      expect(sanitizeCSS(css)).toContain('data:image/png');
    });

    it('should allow data: font URIs', () => {
      const css = 'src: url("data:font/woff2;base64,abc123")';
      expect(sanitizeCSS(css)).toContain('data:font/woff2');
    });

    it('should block dangerous data: MIME types', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const css = 'background: url("data:application/javascript;base64,abc123")';
      const result = sanitizeCSS(css);
      expect(result).toContain('url("")');
      warnSpy.mockRestore();
    });

    it('should handle case-insensitive blocking', () => {
      expect(sanitizeCSS('width: EXPRESSION(1)')).toContain('/* expression blocked */');
      expect(sanitizeCSS('JAVASCRIPT:alert(1)')).toContain('/* javascript blocked */');
    });
  });
});
