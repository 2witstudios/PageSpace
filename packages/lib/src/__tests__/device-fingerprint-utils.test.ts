import { describe, it, expect } from 'vitest';
import {
  validateDeviceFingerprint,
  calculateTrustScore,
} from '../device-fingerprint-utils';

describe('device-fingerprint-utils', () => {
  describe('validateDeviceFingerprint', () => {
    it('validates matching fingerprints', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        '192.168.1.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        '192.168.1.1'
      );

      expect(result.valid).toBe(true);
      expect(result.userAgentMatch).toBe(true);
      expect(result.ipMatch).toBe(true);
      expect(result.suspiciousFactors).toHaveLength(0);
    });

    it('detects User-Agent changes (browser family mismatch)', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        '192.168.1.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        '192.168.1.1'
      );

      expect(result.valid).toBe(false);
      expect(result.userAgentMatch).toBe(false);
      expect(result.suspiciousFactors).toContain('user_agent_mismatch');
    });

    it('allows User-Agent version updates (same browser family)', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        '192.168.1.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
        '192.168.1.1'
      );

      // Should still match because it's the same browser family (Safari) and OS (iOS)
      expect(result.userAgentMatch).toBe(true);
    });

    it('detects IP address changes', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        '192.168.1.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        '192.168.1.2'
      );

      expect(result.valid).toBe(false);
      expect(result.ipMatch).toBe(false);
      expect(result.suspiciousFactors).toContain('ip_address_change');
    });

    it('does not flag unknown IP changes as suspicious', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'unknown',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        '192.168.1.1'
      );

      // When current IP is "unknown", it should not be flagged as suspicious
      // (This handles cases where IP cannot be determined)
      expect(result.suspiciousFactors).not.toContain('ip_address_change');
      expect(result.valid).toBe(true);
    });

    it('detects multiple suspicious factors', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0',
        '192.168.1.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1',
        '192.168.1.2'
      );

      expect(result.valid).toBe(false);
      expect(result.userAgentMatch).toBe(false);
      expect(result.ipMatch).toBe(false);
      expect(result.suspiciousFactors).toHaveLength(2);
      expect(result.suspiciousFactors).toContain('user_agent_mismatch');
      expect(result.suspiciousFactors).toContain('ip_address_change');
    });

    it('handles missing stored fingerprint data', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        '192.168.1.1',
        null,
        null
      );

      // Should be valid when there's no stored data to compare against
      expect(result.valid).toBe(true);
      expect(result.userAgentMatch).toBe(true);
      expect(result.ipMatch).toBe(true);
    });
  });

  describe('calculateTrustScore', () => {
    it('decreases trust score for User-Agent mismatch', () => {
      const currentScore = 1.0;
      const suspiciousFactors = ['user_agent_mismatch'];

      const newScore = calculateTrustScore(currentScore, suspiciousFactors);

      expect(newScore).toBeLessThan(currentScore);
      expect(newScore).toBe(0.8); // Should decrease by 0.2
    });

    it('decreases trust score for IP address change', () => {
      const currentScore = 1.0;
      const suspiciousFactors = ['ip_address_change'];

      const newScore = calculateTrustScore(currentScore, suspiciousFactors);

      expect(newScore).toBeLessThan(currentScore);
      expect(newScore).toBe(0.95); // Should decrease by 0.05
    });

    it('applies multiple penalties cumulatively', () => {
      const currentScore = 1.0;
      const suspiciousFactors = ['user_agent_mismatch', 'ip_address_change'];

      const newScore = calculateTrustScore(currentScore, suspiciousFactors);

      // Should apply both penalties: 1.0 - 0.2 - 0.05 = 0.75
      expect(newScore).toBe(0.75);
    });

    it('does not go below 0.0', () => {
      const currentScore = 0.1;
      const suspiciousFactors = ['user_agent_mismatch', 'ip_address_change'];

      const newScore = calculateTrustScore(currentScore, suspiciousFactors);

      expect(newScore).toBeGreaterThanOrEqual(0.0);
    });

    it('maintains score when no suspicious factors', () => {
      const currentScore = 0.75;
      const suspiciousFactors: string[] = [];

      const newScore = calculateTrustScore(currentScore, suspiciousFactors);

      expect(newScore).toBe(currentScore);
    });

    it('handles degraded trust scores', () => {
      let score = 1.0;

      // Simulate multiple suspicious events over time
      score = calculateTrustScore(score, ['ip_address_change']); // 0.95
      score = calculateTrustScore(score, ['ip_address_change']); // 0.90
      score = calculateTrustScore(score, ['user_agent_mismatch']); // 0.70
      score = calculateTrustScore(score, ['ip_address_change']); // 0.65

      expect(score).toBeCloseTo(0.65, 2); // Use toBeCloseTo for floating point
      expect(score).toBeGreaterThan(0.5); // Still above threshold for alerts
    });

    it('reaches critically low trust score after many violations', () => {
      let score = 1.0;

      // Simulate many suspicious events
      for (let i = 0; i < 5; i++) {
        score = calculateTrustScore(score, ['user_agent_mismatch']);
      }

      expect(score).toBeCloseTo(0.0, 2); // Should bottom out at 0 (with floating point tolerance)
    });
  });

  describe('User-Agent parsing (internal behavior)', () => {
    it('correctly identifies Safari on iOS', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1',
        '192.168.1.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1) AppleWebKit/605.1.15 Safari/604.1',
        '192.168.1.1'
      );

      expect(result.userAgentMatch).toBe(true);
    });

    it('correctly identifies Chrome on Android', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0',
        '192.168.1.1',
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/121.0.0.0',
        '192.168.1.1'
      );

      expect(result.userAgentMatch).toBe(true);
    });

    it('correctly identifies Firefox on desktop', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
        '192.168.1.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
        '192.168.1.1'
      );

      expect(result.userAgentMatch).toBe(true);
    });

    it('correctly identifies Edge browser', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        '192.168.1.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
        '192.168.1.1'
      );

      expect(result.userAgentMatch).toBe(true);
    });

    it('detects OS changes', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        '192.168.1.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36',
        '192.168.1.1'
      );

      expect(result.userAgentMatch).toBe(false);
      expect(result.suspiciousFactors).toContain('user_agent_mismatch');
    });

    it('detects browser family changes', () => {
      const result = validateDeviceFingerprint(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0',
        '192.168.1.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        '192.168.1.1'
      );

      expect(result.userAgentMatch).toBe(false);
      expect(result.suspiciousFactors).toContain('user_agent_mismatch');
    });
  });
});
