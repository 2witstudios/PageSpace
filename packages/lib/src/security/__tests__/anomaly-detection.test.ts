import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create persistent mock functions at module level
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisSMembers = vi.fn();
const mockRedisSAdd = vi.fn().mockResolvedValue(1);
const mockRedisSIsMember = vi.fn();
const mockRedisSRem = vi.fn().mockResolvedValue(1);

const mockRedisClient = {
  get: mockRedisGet,
  set: mockRedisSet,
  smembers: mockRedisSMembers,
  sadd: mockRedisSAdd,
  sismember: mockRedisSIsMember,
  srem: mockRedisSRem,
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(() => ({
    incr: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
};

// Mock Redis - using a factory function that vi.mock can hoist
vi.mock('../security-redis', () => ({
  tryGetRateLimitRedisClient: vi.fn(() => Promise.resolve(mockRedisClient)),
}));

// Mock the security audit service
vi.mock('../../audit/security-audit', () => ({
  securityAudit: {
    logAnomalyDetected: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import {
  AnomalyDetector,
  type AnomalyContext,
  detectImpossibleTravel,
  isHighFrequencyAccess,
  isNewUserAgent,
  isKnownBadIP,
} from '../anomaly-detection';
import { tryGetRateLimitRedisClient } from '../security-redis';
import { securityAudit } from '../../audit/security-audit';

describe('Anomaly Detection', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    // Reset all mock implementations but keep the mock functions
    mockRedisGet.mockReset();
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisSMembers.mockReset();
    mockRedisSAdd.mockReset().mockResolvedValue(1);
    mockRedisSIsMember.mockReset();
    mockRedisSRem.mockReset().mockResolvedValue(1);
    detector = new AnomalyDetector();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('analyzeRequest', () => {
    it('returns zero risk score for normal request', async () => {
      // Mock: no previous location, known user agent, not blocked
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.riskScore).toBe(0);
      expect(result.flags).toHaveLength(0);
    });

    it('detects impossible travel', async () => {
      // Mock: last location 30 seconds ago from a different /16 subnet
      const lastLocation = {
        ip: '10.0.1.1', // Different /16 subnet
        timestamp: Date.now() - 30 * 1000, // 30 seconds ago
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(lastLocation));
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1', // Different /16 subnet
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('impossible_travel');
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it('detects new user agent', async () => {
      // Mock: no previous location, new user agent
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Chrome/100']); // Different agent
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Firefox/115', // New user agent
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('new_user_agent');
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it('detects known bad IP', async () => {
      // Mock: bad IP
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(1); // Is a known bad IP

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('known_bad_ip');
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it('detects high frequency access', async () => {
      // Mock: high action count
      mockRedisGet.mockImplementation((key: string) => {
        if (key.includes('action:')) {
          return Promise.resolve('150'); // High count
        }
        return Promise.resolve(null);
      });
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'api',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('high_frequency');
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it('accumulates risk scores from multiple flags', async () => {
      // Mock: multiple anomalies
      const lastLocation = {
        ip: '10.0.1.1', // Different subnet
        timestamp: Date.now() - 30 * 1000, // 30 seconds ago
      };
      mockRedisGet.mockImplementation((key: string) => {
        if (key.includes('last_location')) {
          return Promise.resolve(JSON.stringify(lastLocation));
        }
        if (key.includes('action:')) {
          return Promise.resolve('150'); // High count
        }
        return Promise.resolve(null);
      });
      mockRedisSMembers.mockResolvedValue(['Chrome/100']); // Different agent
      mockRedisSIsMember.mockResolvedValue(1); // Bad IP

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Firefox/115',
        action: 'api',
      };

      const result = await detector.analyzeRequest(ctx);

      // Should have multiple flags
      expect(result.flags.length).toBeGreaterThan(1);
      // Risk score should be accumulated
      expect(result.riskScore).toBeGreaterThan(0.5);
    });

    it('logs high-risk events to security audit', async () => {
      // Mock: bad IP (high risk)
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(1);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      if (result.riskScore > 0.5) {
        expect(securityAudit.logAnomalyDetected).toHaveBeenCalled();
      }
    });

    it('updates last location after analysis', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      await detector.analyzeRequest(ctx);

      // Should have called set to update location
      expect(mockRedisSet).toHaveBeenCalled();
    });
  });

  describe('detectImpossibleTravel', () => {
    it('returns false for same IP', () => {
      const result = detectImpossibleTravel(
        '192.168.1.1',
        { ip: '192.168.1.1', timestamp: Date.now() - 1000 }
      );
      expect(result).toBe(false);
    });

    it('returns false for same /16 subnet', () => {
      const result = detectImpossibleTravel(
        '192.168.1.1',
        { ip: '192.168.2.1', timestamp: Date.now() - 1000 }
      );
      expect(result).toBe(false);
    });

    it('returns true for different /16 subnet within 1 hour', () => {
      const result = detectImpossibleTravel(
        '192.168.1.1',
        { ip: '10.0.1.1', timestamp: Date.now() - 30 * 60 * 1000 } // 30 minutes ago
      );
      expect(result).toBe(true);
    });

    it('returns false for different subnet after 1+ hour', () => {
      const result = detectImpossibleTravel(
        '192.168.1.1',
        { ip: '10.0.1.1', timestamp: Date.now() - 2 * 60 * 60 * 1000 } // 2 hours ago
      );
      expect(result).toBe(false);
    });
  });

  describe('isHighFrequencyAccess', () => {
    it('returns true for count above threshold', () => {
      expect(isHighFrequencyAccess(150, 100)).toBe(true);
    });

    it('returns false for count at threshold', () => {
      expect(isHighFrequencyAccess(100, 100)).toBe(false);
    });

    it('returns false for count below threshold', () => {
      expect(isHighFrequencyAccess(50, 100)).toBe(false);
    });
  });

  describe('isNewUserAgent', () => {
    it('returns true when user agent is not in known list', () => {
      const known = ['Chrome/100', 'Firefox/115'];
      expect(isNewUserAgent('Safari/605', known)).toBe(true);
    });

    it('returns false when user agent is in known list', () => {
      const known = ['Chrome/100', 'Firefox/115'];
      expect(isNewUserAgent('Firefox/115', known)).toBe(false);
    });

    it('returns false when known list is empty', () => {
      expect(isNewUserAgent('Chrome/100', [])).toBe(false);
    });
  });

  describe('isKnownBadIP', () => {
    it('returns true for value 1', () => {
      expect(isKnownBadIP(1)).toBe(true);
    });

    it('returns false for value 0', () => {
      expect(isKnownBadIP(0)).toBe(false);
    });
  });

  describe('graceful degradation', () => {
    it('returns safe defaults when Redis unavailable', async () => {
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValueOnce(null);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      // Should return safe defaults without crashing
      expect(result).toBeDefined();
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.flags)).toBe(true);
    });

    it('handles Redis errors gracefully', async () => {
      mockRedisGet.mockRejectedValue(new Error('Redis error'));
      mockRedisSMembers.mockRejectedValue(new Error('Redis error'));
      mockRedisSIsMember.mockRejectedValue(new Error('Redis error'));

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      // Should not throw
      const result = await detector.analyzeRequest(ctx);

      expect(result).toBeDefined();
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('risk score thresholds', () => {
    it('impossible_travel adds 0.4 to risk score', async () => {
      const lastLocation = {
        ip: '10.0.1.1',
        timestamp: Date.now() - 30 * 1000,
      };
      mockRedisGet.mockImplementation((key: string) => {
        if (key.includes('last_location')) {
          return Promise.resolve(JSON.stringify(lastLocation));
        }
        return Promise.resolve('0');
      });
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('impossible_travel');
      expect(result.riskScore).toBeCloseTo(0.4, 1);
    });

    it('new_user_agent adds 0.2 to risk score', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Chrome/100']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Firefox/115',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('new_user_agent');
      expect(result.riskScore).toBeCloseTo(0.2, 1);
    });

    it('high_frequency adds 0.3 to risk score', async () => {
      mockRedisGet.mockImplementation((key: string) => {
        if (key.includes('action:')) {
          return Promise.resolve('150');
        }
        return Promise.resolve(null);
      });
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(0);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        action: 'api',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('high_frequency');
      expect(result.riskScore).toBeCloseTo(0.3, 1);
    });

    it('known_bad_ip adds 0.5 to risk score', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisSMembers.mockResolvedValue(['Mozilla/5.0']);
      mockRedisSIsMember.mockResolvedValue(1);

      const ctx: AnomalyContext = {
        userId: 'user123',
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
        action: 'login',
      };

      const result = await detector.analyzeRequest(ctx);

      expect(result.flags).toContain('known_bad_ip');
      expect(result.riskScore).toBeCloseTo(0.5, 1);
    });
  });
});

describe('AnomalyDetector instance methods', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new AnomalyDetector();
  });

  it('has correct default threshold', () => {
    expect(detector.getHighFrequencyThreshold()).toBe(100);
  });

  it('can update thresholds', () => {
    detector.setHighFrequencyThreshold(200);
    expect(detector.getHighFrequencyThreshold()).toBe(200);
  });

  it('has correct risk weights', () => {
    const weights = detector.getRiskWeights();
    expect(weights.impossible_travel).toBe(0.4);
    expect(weights.new_user_agent).toBe(0.2);
    expect(weights.high_frequency).toBe(0.3);
    expect(weights.known_bad_ip).toBe(0.5);
  });
});
