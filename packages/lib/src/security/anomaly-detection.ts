/**
 * Anomaly Detection Module
 *
 * Provides basic anomaly detection for suspicious security activity.
 * Part of the Zero-Trust Security Architecture (Phase 5).
 *
 * Detection Types:
 * - Impossible travel (IP-based geolocation heuristic)
 * - New user agent detection
 * - High-frequency access patterns
 * - Known bad IP detection
 *
 * Risk Score Weights:
 * - impossible_travel: 0.4
 * - new_user_agent: 0.2
 * - high_frequency: 0.3
 * - known_bad_ip: 0.5
 */

import { tryGetRateLimitRedisClient } from './security-redis';
import { securityAudit } from '../audit/security-audit';
import { loggers } from '../logging/logger-config';

/**
 * Context for anomaly analysis
 */
export interface AnomalyContext {
  userId: string;
  ipAddress: string;
  userAgent: string;
  action: string;
}

/**
 * Result of anomaly analysis
 */
export interface AnomalyResult {
  riskScore: number;
  flags: string[];
}

/**
 * Last location data stored in Redis
 */
interface LastLocation {
  ip: string;
  timestamp: number;
}

/**
 * Risk weights for different anomaly types
 */
interface RiskWeights {
  impossible_travel: number;
  new_user_agent: number;
  high_frequency: number;
  known_bad_ip: number;
}

const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  impossible_travel: 0.4,
  new_user_agent: 0.2,
  high_frequency: 0.3,
  known_bad_ip: 0.5,
};

const DEFAULT_HIGH_FREQUENCY_THRESHOLD = 100;
const LOCATION_TTL_SECONDS = 86400; // 24 hours
const USER_AGENT_SET_TTL_SECONDS = 604800; // 7 days

/**
 * Detect impossible travel based on IP changes within short time windows.
 *
 * Uses a simplified heuristic: different /16 subnet within 1 hour is suspicious.
 * Production implementations should use GeoIP for more accurate detection.
 *
 * @param currentIp - Current request IP address
 * @param lastLocation - Previous location data
 * @returns true if impossible travel detected
 */
export function detectImpossibleTravel(
  currentIp: string,
  lastLocation: LastLocation
): boolean {
  // Same IP is not suspicious
  if (currentIp === lastLocation.ip) {
    return false;
  }

  const timeDiffMs = Date.now() - lastLocation.timestamp;
  const timeDiffHours = timeDiffMs / (1000 * 60 * 60);

  // If more than 1 hour, allow IP change (reasonable travel time)
  if (timeDiffHours >= 1) {
    return false;
  }

  // Extract /16 subnet prefixes (first two octets)
  const currentPrefix = currentIp.split('.').slice(0, 2).join('.');
  const lastPrefix = lastLocation.ip.split('.').slice(0, 2).join('.');

  // Different /16 subnet in under an hour is suspicious
  return currentPrefix !== lastPrefix;
}

/**
 * Check if access frequency is suspiciously high.
 *
 * @param count - Number of actions in the current window
 * @param threshold - Maximum allowed actions
 * @returns true if frequency exceeds threshold
 */
export function isHighFrequencyAccess(count: number, threshold: number): boolean {
  return count > threshold;
}

/**
 * Check if user agent is new (not previously seen).
 *
 * @param userAgent - Current user agent string
 * @param knownAgents - List of known user agents for this user
 * @returns true if user agent is new and user has known agents
 */
export function isNewUserAgent(userAgent: string, knownAgents: string[]): boolean {
  // If no known agents, don't flag as new (first visit)
  if (knownAgents.length === 0) {
    return false;
  }

  return !knownAgents.includes(userAgent);
}

/**
 * Check if IP is in the known bad IP list.
 *
 * @param sismemberResult - Result from Redis SISMEMBER (1 = member, 0 = not member)
 * @returns true if IP is known bad
 */
export function isKnownBadIP(sismemberResult: number): boolean {
  return sismemberResult === 1;
}

/**
 * Anomaly Detector class for analyzing request patterns.
 *
 * Uses Redis for storing:
 * - Last known location per user
 * - Known user agents per user
 * - Action counts per user
 * - Known bad IP set
 */
export class AnomalyDetector {
  private highFrequencyThreshold: number;
  private riskWeights: RiskWeights;

  constructor(options?: { highFrequencyThreshold?: number; riskWeights?: Partial<RiskWeights> }) {
    this.highFrequencyThreshold = options?.highFrequencyThreshold ?? DEFAULT_HIGH_FREQUENCY_THRESHOLD;
    this.riskWeights = {
      ...DEFAULT_RISK_WEIGHTS,
      ...options?.riskWeights,
    };
  }

  /**
   * Analyze a request for anomalies.
   *
   * @param ctx - Request context
   * @returns Anomaly result with risk score and flags
   */
  async analyzeRequest(ctx: AnomalyContext): Promise<AnomalyResult> {
    const flags: string[] = [];
    let riskScore = 0;

    try {
      const redis = await tryGetRateLimitRedisClient();

      if (!redis) {
        // Redis unavailable - return safe defaults
        loggers.api.warn('Anomaly detection: Redis unavailable, using safe defaults');
        return { riskScore: 0, flags: [] };
      }

      // Check for impossible travel
      try {
        const lastLocationData = await redis.get(`user:${ctx.userId}:last_location`);
        if (lastLocationData) {
          const lastLocation: LastLocation = JSON.parse(lastLocationData);
          if (detectImpossibleTravel(ctx.ipAddress, lastLocation)) {
            flags.push('impossible_travel');
            riskScore += this.riskWeights.impossible_travel;
          }
        }
      } catch (error) {
        loggers.api.debug('Anomaly detection: Failed to check impossible travel', { error });
      }

      // Update last location
      try {
        await redis.set(
          `user:${ctx.userId}:last_location`,
          JSON.stringify({ ip: ctx.ipAddress, timestamp: Date.now() }),
          'EX',
          LOCATION_TTL_SECONDS
        );
      } catch (error) {
        loggers.api.debug('Anomaly detection: Failed to update last location', { error });
      }

      // Check for new user agent
      try {
        const knownAgents = await redis.smembers(`user:${ctx.userId}:user_agents`);
        if (isNewUserAgent(ctx.userAgent, knownAgents)) {
          flags.push('new_user_agent');
          riskScore += this.riskWeights.new_user_agent;
        }

        // Add current user agent to known set (fire and forget)
        redis.sadd(`user:${ctx.userId}:user_agents`, ctx.userAgent).catch(() => {});
      } catch (error) {
        loggers.api.debug('Anomaly detection: Failed to check user agent', { error });
      }

      // Check for high frequency access
      try {
        const actionCount = await redis.get(`user:${ctx.userId}:action:${ctx.action}`);
        const count = parseInt(actionCount ?? '0', 10);
        if (isHighFrequencyAccess(count, this.highFrequencyThreshold)) {
          flags.push('high_frequency');
          riskScore += this.riskWeights.high_frequency;
        }
      } catch (error) {
        loggers.api.debug('Anomaly detection: Failed to check frequency', { error });
      }

      // Check for known bad IP
      try {
        const isBadIP = await redis.sismember('security:bad_ips', ctx.ipAddress);
        if (isKnownBadIP(isBadIP)) {
          flags.push('known_bad_ip');
          riskScore += this.riskWeights.known_bad_ip;
        }
      } catch (error) {
        loggers.api.debug('Anomaly detection: Failed to check bad IP', { error });
      }

      // Log high-risk events
      if (riskScore > 0.5) {
        try {
          await securityAudit.logAnomalyDetected(
            ctx.userId,
            ctx.ipAddress,
            riskScore,
            flags
          );
        } catch (error) {
          loggers.api.warn('Anomaly detection: Failed to log to security audit', { error });
        }
      }

      return { riskScore, flags };
    } catch (error) {
      loggers.api.error('Anomaly detection: Unexpected error', { error });
      // Return safe defaults on unexpected errors
      return { riskScore: 0, flags: [] };
    }
  }

  /**
   * Get the current high frequency threshold.
   */
  getHighFrequencyThreshold(): number {
    return this.highFrequencyThreshold;
  }

  /**
   * Set the high frequency threshold.
   */
  setHighFrequencyThreshold(threshold: number): void {
    this.highFrequencyThreshold = threshold;
  }

  /**
   * Get the current risk weights.
   */
  getRiskWeights(): RiskWeights {
    return { ...this.riskWeights };
  }

  /**
   * Add an IP to the known bad IP set.
   * Useful for blocking IPs after detecting malicious activity.
   */
  async addBadIP(ip: string): Promise<boolean> {
    try {
      const redis = await tryGetRateLimitRedisClient();
      if (!redis) {
        return false;
      }
      await redis.sadd('security:bad_ips', ip);
      return true;
    } catch (error) {
      loggers.api.warn('Anomaly detection: Failed to add bad IP', { error, ip });
      return false;
    }
  }

  /**
   * Remove an IP from the known bad IP set.
   */
  async removeBadIP(ip: string): Promise<boolean> {
    try {
      const redis = await tryGetRateLimitRedisClient();
      if (!redis) {
        return false;
      }
      await redis.srem('security:bad_ips', ip);
      return true;
    } catch (error) {
      loggers.api.warn('Anomaly detection: Failed to remove bad IP', { error, ip });
      return false;
    }
  }

  /**
   * Increment action counter for rate limiting analysis.
   * Call this on each API request to track frequency.
   */
  async incrementActionCounter(userId: string, action: string, windowSeconds: number = 60): Promise<void> {
    try {
      const redis = await tryGetRateLimitRedisClient();
      if (!redis) {
        return;
      }

      const key = `user:${userId}:action:${action}`;
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, windowSeconds);
      await pipeline.exec();
    } catch (error) {
      loggers.api.debug('Anomaly detection: Failed to increment action counter', { error });
    }
  }
}

/**
 * Singleton instance for application-wide use.
 */
export const anomalyDetector = new AnomalyDetector();
