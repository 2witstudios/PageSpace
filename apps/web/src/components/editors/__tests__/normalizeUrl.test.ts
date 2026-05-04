import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../LinkButton';

describe('normalizeUrl', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });

  it('preserves absolute URLs', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://example.com/path?q=1')).toBe('http://example.com/path?q=1');
    expect(normalizeUrl('ftp://ftp.example.com/file')).toBe('ftp://ftp.example.com/file');
  });

  it('preserves mailto and tel URIs', () => {
    expect(normalizeUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
    expect(normalizeUrl('tel:+15551234567')).toBe('tel:+15551234567');
  });

  it('preserves relative paths and fragments', () => {
    expect(normalizeUrl('/foo/bar')).toBe('/foo/bar');
    expect(normalizeUrl('#section')).toBe('#section');
    expect(normalizeUrl('?view=compact')).toBe('?view=compact');
    expect(normalizeUrl('./doc')).toBe('./doc');
    expect(normalizeUrl('../parent')).toBe('../parent');
  });

  it('passes bare paths without dots through unchanged', () => {
    expect(normalizeUrl('bar/baz')).toBe('bar/baz');
    expect(normalizeUrl('localhost')).toBe('localhost');
  });

  it('prepends https:// to bare hostnames', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeUrl('sub.example.co.uk')).toBe('https://sub.example.co.uk');
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
    expect(normalizeUrl('  /foo  ')).toBe('/foo');
  });

  it('rejects javascript:, data:, and vbscript: URIs as XSS vectors', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBe('');
    expect(normalizeUrl('JavaScript:alert(1)')).toBe('');
    expect(normalizeUrl('  javascript:alert(1)')).toBe('');
    expect(normalizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(normalizeUrl('vbscript:msgbox')).toBe('');
  });
});
