import { describe, it, expect } from 'vitest';
import { normalizeZoomReturnPath, ZOOM_DEFAULT_RETURN_PATH } from '../return-url';

describe('normalizeZoomReturnPath', () => {
  it('given undefined, should return the default path', () => {
    expect(normalizeZoomReturnPath(undefined)).toBe(ZOOM_DEFAULT_RETURN_PATH);
  });

  it('given null, should return the default path', () => {
    expect(normalizeZoomReturnPath(null)).toBe(ZOOM_DEFAULT_RETURN_PATH);
  });

  it('given empty string, should return the default path', () => {
    expect(normalizeZoomReturnPath('')).toBe(ZOOM_DEFAULT_RETURN_PATH);
  });

  it('given an absolute external URL, should return the default path', () => {
    expect(normalizeZoomReturnPath('https://evil.com/steal')).toBe(ZOOM_DEFAULT_RETURN_PATH);
  });

  it('given a protocol-relative URL, should return the default path', () => {
    expect(normalizeZoomReturnPath('//evil.com/steal')).toBe(ZOOM_DEFAULT_RETURN_PATH);
  });

  it('given a valid relative path, should return it unchanged', () => {
    expect(normalizeZoomReturnPath('/settings/integrations/zoom')).toBe('/settings/integrations/zoom');
  });

  it('given a relative path with query string, should preserve query', () => {
    expect(normalizeZoomReturnPath('/settings/integrations/zoom?tab=advanced')).toBe(
      '/settings/integrations/zoom?tab=advanced'
    );
  });

  it('given a relative path with a URL-valued query param, should pass through unchanged', () => {
    expect(normalizeZoomReturnPath('/safe?redirect=https://evil.com')).toBe('/safe?redirect=https://evil.com');
  });

  it('given a non-string value, should return the default path', () => {
    expect(normalizeZoomReturnPath(42 as unknown as string)).toBe(ZOOM_DEFAULT_RETURN_PATH);
  });

  it('given a path with a fragment, should strip fragment and keep pathname+search', () => {
    const result = normalizeZoomReturnPath('/settings#section');
    expect(result).toBe('/settings');
  });
});
