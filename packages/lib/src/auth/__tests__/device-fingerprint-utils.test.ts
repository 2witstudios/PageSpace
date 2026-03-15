import { describe, it, expect } from 'vitest';
import {
  getClientIP,
  detectPlatform,
  generateServerFingerprint,
  validateDeviceFingerprint,
  calculateTrustScore,
  isSameSubnet,
  isRapidRefresh,
  extractDeviceMetadata,
  generateDefaultDeviceName,
  anonymizeIP,
} from '../device-fingerprint-utils';

describe('device-fingerprint-utils', () => {
  describe('getClientIP', () => {
    it('should extract IP from x-forwarded-for header', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      });
      expect(getClientIP(request)).toBe('1.2.3.4');
    });

    it('should extract IP from x-real-ip header', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-real-ip': '10.0.0.1' },
      });
      expect(getClientIP(request)).toBe('10.0.0.1');
    });

    it('should return unknown when no IP headers present', () => {
      const request = new Request('http://localhost');
      expect(getClientIP(request)).toBe('unknown');
    });

    it('should prefer x-forwarded-for over x-real-ip', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      });
      expect(getClientIP(request)).toBe('1.2.3.4');
    });
  });

  describe('detectPlatform', () => {
    it('should detect desktop (Electron)', () => {
      expect(detectPlatform('Mozilla/5.0 Electron/28.0.0')).toBe('desktop');
    });

    it('should detect iOS (iPhone)', () => {
      expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios');
    });

    it('should detect iOS (iPad)', () => {
      expect(detectPlatform('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('ios');
    });

    it('should detect Android', () => {
      expect(detectPlatform('Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    });

    it('should default to web', () => {
      expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('web');
    });
  });

  describe('generateServerFingerprint', () => {
    it('should return consistent hash for same input', () => {
      const h1 = generateServerFingerprint('Chrome/120', '1.2.3.4');
      const h2 = generateServerFingerprint('Chrome/120', '1.2.3.4');
      expect(h1).toBe(h2);
    });

    it('should return different hash for different inputs', () => {
      const h1 = generateServerFingerprint('Chrome/120', '1.2.3.4');
      const h2 = generateServerFingerprint('Firefox/120', '1.2.3.4');
      expect(h1).not.toBe(h2);
    });

    it('should return 64-char hex string (SHA-256)', () => {
      const hash = generateServerFingerprint('ua', 'ip');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('validateDeviceFingerprint', () => {
    it('should return valid when everything matches', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 Chrome/120 Mac OS X',
        '1.2.3.4',
        'Mozilla/5.0 Chrome/119 Mac OS X',
        '1.2.3.4'
      );
      expect(result.valid).toBe(true);
      expect(result.userAgentMatch).toBe(true);
      expect(result.ipMatch).toBe(true);
      expect(result.suspiciousFactors).toHaveLength(0);
    });

    it('should flag user agent mismatch', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 Firefox/120 Linux',
        '1.2.3.4',
        'Mozilla/5.0 Chrome/120 Mac OS X',
        '1.2.3.4'
      );
      expect(result.valid).toBe(false);
      expect(result.userAgentMatch).toBe(false);
      expect(result.suspiciousFactors).toContain('user_agent_mismatch');
    });

    it('should flag IP address change', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 Chrome/120',
        '5.6.7.8',
        'Mozilla/5.0 Chrome/119',
        '1.2.3.4'
      );
      expect(result.ipMatch).toBe(false);
      expect(result.suspiciousFactors).toContain('ip_address_change');
    });

    it('should not flag IP change when current IP is unknown', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 Chrome/120',
        'unknown',
        'Mozilla/5.0 Chrome/119',
        '1.2.3.4'
      );
      expect(result.ipMatch).toBe(true);
    });

    it('should handle null stored values', () => {
      const result = validateDeviceFingerprint('Chrome', '1.2.3.4', null, null);
      expect(result.valid).toBe(true);
    });
  });

  describe('calculateTrustScore', () => {
    it('should return same score with no suspicious factors', () => {
      expect(calculateTrustScore(1.0, [])).toBe(1.0);
    });

    it('should decrease score for user_agent_mismatch', () => {
      expect(calculateTrustScore(1.0, ['user_agent_mismatch'])).toBe(0.8);
    });

    it('should decrease score for ip_address_change', () => {
      expect(calculateTrustScore(1.0, ['ip_address_change'])).toBe(0.95);
    });

    it('should decrease score for location_change', () => {
      expect(calculateTrustScore(1.0, ['location_change'])).toBe(0.9);
    });

    it('should decrease score for rapid_refresh', () => {
      expect(calculateTrustScore(1.0, ['rapid_refresh'])).toBe(0.85);
    });

    it('should decrease score for unknown factors', () => {
      expect(calculateTrustScore(1.0, ['unknown_factor'])).toBe(0.95);
    });

    it('should clamp score to 0 minimum', () => {
      expect(calculateTrustScore(0.1, ['user_agent_mismatch'])).toBe(0);
    });

    it('should clamp score to 1 maximum', () => {
      expect(calculateTrustScore(1.5, [])).toBe(1);
    });

    it('should accumulate multiple factors', () => {
      const score = calculateTrustScore(1.0, ['user_agent_mismatch', 'ip_address_change']);
      expect(score).toBe(0.75);
    });
  });

  describe('isSameSubnet', () => {
    it('should return true for identical IPs', () => {
      expect(isSameSubnet('1.2.3.4', '1.2.3.4')).toBe(true);
    });

    it('should return true for same /24 subnet', () => {
      expect(isSameSubnet('192.168.1.100', '192.168.1.200')).toBe(true);
    });

    it('should return false for different subnets', () => {
      expect(isSameSubnet('192.168.1.100', '192.168.2.100')).toBe(false);
    });

    it('should return false when one IP is unknown', () => {
      expect(isSameSubnet('1.2.3.4', 'unknown')).toBe(false);
      expect(isSameSubnet('unknown', '1.2.3.4')).toBe(false);
    });

    it('should return false for invalid IPv4', () => {
      expect(isSameSubnet('not-an-ip', '1.2.3.4')).toBe(false);
    });
  });

  describe('isRapidRefresh', () => {
    it('should return false for null lastUsedAt', () => {
      expect(isRapidRefresh(null)).toBe(false);
    });

    it('should return true for very recent usage', () => {
      expect(isRapidRefresh(new Date(Date.now() - 5000))).toBe(true);
    });

    it('should return false for usage more than 1 minute ago', () => {
      expect(isRapidRefresh(new Date(Date.now() - 120000))).toBe(false);
    });
  });

  describe('extractDeviceMetadata', () => {
    it('should extract metadata from request', () => {
      const request = new Request('http://localhost', {
        headers: {
          'user-agent': 'Mozilla/5.0 Electron/28.0.0',
          'x-forwarded-for': '10.0.0.1',
        },
      });
      const meta = extractDeviceMetadata(request);
      expect(meta.userAgent).toBe('Mozilla/5.0 Electron/28.0.0');
      expect(meta.ipAddress).toBe('10.0.0.1');
      expect(meta.platform).toBe('desktop');
    });

    it('should use unknown for missing user-agent', () => {
      const request = new Request('http://localhost');
      const meta = extractDeviceMetadata(request);
      expect(meta.userAgent).toBe('unknown');
    });
  });

  describe('generateDefaultDeviceName', () => {
    it('should return iPad for iPad user agent', () => {
      expect(generateDefaultDeviceName('ios', 'iPad; CPU OS 17')).toBe('iPad');
    });

    it('should return iPhone for iPhone user agent', () => {
      expect(generateDefaultDeviceName('ios', 'iPhone; CPU iPhone OS')).toBe('iPhone');
    });

    it('should return iOS Device for other iOS', () => {
      expect(generateDefaultDeviceName('ios', 'iPod touch')).toBe('iOS Device');
    });

    it('should return Android Tablet for tablet', () => {
      expect(generateDefaultDeviceName('android', 'Android Tablet')).toBe('Android Tablet');
    });

    it('should return Android Phone for phone', () => {
      expect(generateDefaultDeviceName('android', 'Android Phone')).toBe('Android Phone');
    });

    it('should return Desktop (Mac) for mac', () => {
      expect(generateDefaultDeviceName('desktop', 'Electron Mac')).toBe('Desktop (Mac)');
    });

    it('should return Desktop (Windows) for windows', () => {
      expect(generateDefaultDeviceName('desktop', 'Electron Windows')).toBe('Desktop (Windows)');
    });

    it('should return Desktop (Linux) for linux', () => {
      expect(generateDefaultDeviceName('desktop', 'Electron Linux')).toBe('Desktop (Linux)');
    });

    it('should return Desktop for unknown desktop OS', () => {
      expect(generateDefaultDeviceName('desktop', 'Electron FreeBSD')).toBe('Desktop');
    });

    it('should return Chrome Browser', () => {
      expect(generateDefaultDeviceName('web', 'Chrome/120')).toBe('Chrome Browser');
    });

    it('should return Firefox Browser', () => {
      expect(generateDefaultDeviceName('web', 'Firefox/120')).toBe('Firefox Browser');
    });

    it('should return Safari Browser', () => {
      expect(generateDefaultDeviceName('web', 'Safari/605')).toBe('Safari Browser');
    });

    it('should return Edge Browser', () => {
      expect(generateDefaultDeviceName('web', 'Edge/120')).toBe('Edge Browser');
    });

    it('should return Web Browser for unknown browser', () => {
      expect(generateDefaultDeviceName('web', 'UnknownBrowser/1.0')).toBe('Web Browser');
    });
  });

  describe('anonymizeIP', () => {
    it('should return unknown as-is', () => {
      expect(anonymizeIP('unknown')).toBe('unknown');
    });

    it('should anonymize IPv4 by replacing last octet', () => {
      expect(anonymizeIP('192.168.1.100')).toBe('192.168.1.xxx');
    });

    it('should anonymize IPv6 by keeping first 4 groups', () => {
      expect(anonymizeIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
        '2001:0db8:85a3:0000:xxxx:xxxx:xxxx:xxxx'
      );
    });

    it('should return unknown for unrecognized format', () => {
      expect(anonymizeIP('not-an-ip')).toBe('unknown');
    });
  });
});
