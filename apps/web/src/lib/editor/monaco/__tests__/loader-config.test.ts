import { describe, expect, it } from 'vitest';
import {
  buildMonacoVsPath,
  getMonacoVsPath,
  resolveAssetPrefix,
  resolveMonacoVsPath,
  trimTrailingSlash,
} from '../loader-config';

describe('loader-config', () => {
  describe('trimTrailingSlash', () => {
    it('removes a trailing slash when present', () => {
      expect(trimTrailingSlash('/assets/')).toBe('/assets');
    });

    it('returns original value when no trailing slash exists', () => {
      expect(trimTrailingSlash('/assets')).toBe('/assets');
    });
  });

  describe('resolveAssetPrefix', () => {
    const origin = 'https://app.pagespace.local';

    it('returns empty string for empty asset prefix', () => {
      expect(resolveAssetPrefix('', origin)).toBe('');
    });

    it('returns empty string for root-only asset prefix', () => {
      expect(resolveAssetPrefix('/', origin)).toBe('');
    });

    it('normalizes relative asset prefix and trims trailing slash', () => {
      expect(resolveAssetPrefix('/app-assets/', origin)).toBe('/app-assets');
    });

    it('accepts same-origin absolute asset prefix and returns pathname only', () => {
      expect(resolveAssetPrefix('https://app.pagespace.local/cdn/', origin)).toBe('/cdn');
    });

    it('falls back to empty prefix for cross-origin absolute asset prefix', () => {
      expect(resolveAssetPrefix('https://cdn.example.com/assets', origin)).toBe('');
    });
  });

  describe('resolveMonacoVsPath', () => {
    const origin = 'https://app.pagespace.local';

    it('builds default Monaco vs path for empty asset prefix', () => {
      expect(resolveMonacoVsPath('', origin)).toBe('/_next/static/monaco/vs');
    });

    it('builds Monaco vs path using normalized relative asset prefix', () => {
      expect(resolveMonacoVsPath('/app-assets/', origin)).toBe('/app-assets/_next/static/monaco/vs');
    });

    it('falls back to default Monaco vs path for cross-origin asset prefix', () => {
      expect(resolveMonacoVsPath('https://cdn.example.com/assets', origin)).toBe('/_next/static/monaco/vs');
    });
  });

  describe('buildMonacoVsPath', () => {
    it('concatenates asset prefix and Monaco vs relative path', () => {
      expect(buildMonacoVsPath('/tenant')).toBe('/tenant/_next/static/monaco/vs');
    });
  });

  describe('getMonacoVsPath', () => {
    it('reads asset prefix from __NEXT_DATA__ and resolves Monaco vs path', () => {
      const monacoWindow = {
        __NEXT_DATA__: {
          assetPrefix: '/tenant-assets/',
        },
        location: {
          origin: 'https://app.pagespace.local',
        },
      } as unknown as Window & {
        __NEXT_DATA__?: {
          assetPrefix?: string;
        };
      };

      expect(getMonacoVsPath(monacoWindow)).toBe('/tenant-assets/_next/static/monaco/vs');
    });
  });
});
