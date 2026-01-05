/**
 * Security Test Utilities
 *
 * Shared utilities for security testing across the codebase.
 * Use these to test input validation, timing attacks, race conditions, etc.
 */

import { createHash, randomBytes } from 'crypto';

// =============================================================================
// Malicious Input Generators
// =============================================================================

/**
 * Common malicious inputs for security testing.
 * Use with input validation tests to ensure proper sanitization.
 */
export function getMaliciousInputs(): Record<string, string[]> {
  return {
    sqlInjection: [
      "' OR '1'='1",
      "'; DROP TABLE users--",
      "1; SELECT * FROM users",
      "1' AND '1'='1",
      "admin'--",
      "1 UNION SELECT * FROM users",
      "'; WAITFOR DELAY '0:0:5'--",
    ],
    xss: [
      '<script>alert("xss")</script>',
      '"><script>alert("xss")</script>',
      '<img src=x onerror=alert("xss")>',
      '<svg onload=alert("xss")>',
      'javascript:alert("xss")',
      '<body onload=alert("xss")>',
      '<iframe src="javascript:alert(\'xss\')">',
      "'-alert(1)-'",
    ],
    pathTraversal: [
      '../../../etc/passwd',
      '..\\..\\..\\etc\\passwd',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//....//etc/passwd',
      '..//..//..//etc/passwd',
      '%252e%252e%252fetc%252fpasswd',
      '/etc/passwd%00.jpg',
      '..%c0%af..%c0%af..%c0%afetc/passwd',
    ],
    ssrf: [
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://[::1]',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal',
      'file:///etc/passwd',
      'gopher://localhost:25',
      'http://0.0.0.0',
      'http://localtest.me',
      'http://127.0.0.1.nip.io',
    ],
    commandInjection: [
      '; ls -la',
      '| cat /etc/passwd',
      '`whoami`',
      '$(id)',
      '& ping -c 1 attacker.com',
      '\n/bin/sh',
      '|| true',
    ],
    ldapInjection: [
      '*',
      '*)(&',
      '*)(uid=*))(|(uid=*',
      'admin)(&)',
      '*)((|userPassword=*)',
    ],
    headerInjection: [
      'value\r\nX-Injected: header',
      'value\nSet-Cookie: evil=1',
      'value\r\n\r\n<script>alert(1)</script>',
    ],
    nullByte: [
      'file.txt\x00.jpg',
      'file\x00.exe',
      '../../../etc/passwd\x00.png',
    ],
  };
}

/**
 * Get a flat array of all malicious inputs
 */
export function getAllMaliciousInputs(): string[] {
  const inputs = getMaliciousInputs();
  return Object.values(inputs).flat();
}

// =============================================================================
// Race Condition Testing
// =============================================================================

/**
 * Execute multiple requests concurrently to test for race conditions.
 * Uses a barrier pattern to maximize concurrency.
 *
 * @example
 * const results = await racingRequests(() => refreshToken(token), 10);
 * const successes = results.filter(r => r.success);
 * expect(successes.length).toBe(1); // Only one should succeed
 */
export async function racingRequests<T>(
  fn: () => Promise<T>,
  count: number = 10
): Promise<T[]> {
  // Create a barrier that all promises wait on
  let releaseBarrier: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  // Create all promises, each waiting on the barrier
  const promises = Array(count)
    .fill(null)
    .map(async () => {
      await barrier;
      return fn();
    });

  // Release all at once for maximum concurrency
  setImmediate(() => releaseBarrier());

  return Promise.all(promises);
}

/**
 * Execute requests with controlled timing to test sequential race conditions.
 *
 * @example
 * const results = await sequentialRace(() => updateCounter(), 5, 10);
 */
export async function sequentialRace<T>(
  fn: () => Promise<T>,
  count: number,
  delayMs: number = 0
): Promise<T[]> {
  const results: T[] = [];

  for (let i = 0; i < count; i++) {
    if (delayMs > 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    results.push(await fn());
  }

  return results;
}

// =============================================================================
// JWT Utilities
// =============================================================================

/**
 * Extract claims from a JWT without verification.
 * Useful for testing token contents.
 */
export function extractJWTClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    throw new Error('Failed to parse JWT payload');
  }
}

/**
 * Extract JWT header for algorithm verification tests
 */
export function extractJWTHeader(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  try {
    const header = Buffer.from(parts[0], 'base64url').toString('utf-8');
    return JSON.parse(header);
  } catch {
    throw new Error('Failed to parse JWT header');
  }
}

/**
 * Create a tampered JWT (for testing signature verification)
 */
export function tamperJWTClaim(
  token: string,
  claim: string,
  value: unknown
): string {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  payload[claim] = value;

  const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${parts[0]}.${tamperedPayload}.${parts[2]}`;
}

// =============================================================================
// Timing Attack Helpers
// =============================================================================

/**
 * Measure execution time of a function in nanoseconds.
 * Use for timing attack detection tests.
 */
export async function measureExecutionTime(
  fn: () => Promise<unknown>
): Promise<bigint> {
  const start = process.hrtime.bigint();
  await fn();
  const end = process.hrtime.bigint();
  return end - start;
}

/**
 * Run multiple timing measurements and return statistics.
 * Useful for detecting timing leaks in comparisons.
 */
export async function timingAnalysis(
  fn: () => Promise<unknown>,
  iterations: number = 100
): Promise<{ mean: number; stdDev: number; min: bigint; max: bigint }> {
  const times: bigint[] = [];

  for (let i = 0; i < iterations; i++) {
    times.push(await measureExecutionTime(fn));
  }

  const numTimes = times.map((t) => Number(t));
  const mean = numTimes.reduce((a, b) => a + b, 0) / numTimes.length;
  const variance =
    numTimes.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / numTimes.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean,
    stdDev,
    min: times.reduce((a, b) => (a < b ? a : b)),
    max: times.reduce((a, b) => (a > b ? a : b)),
  };
}

// =============================================================================
// Token Generation for Tests
// =============================================================================

/**
 * Generate a random token for testing.
 */
export function generateTestToken(prefix: string = 'test'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/**
 * Hash a token using SHA-256 (same as production).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// =============================================================================
// Request Simulation
// =============================================================================

/**
 * Simulate request headers for testing.
 */
export function createMockHeaders(overrides: Record<string, string> = {}): Headers {
  const defaults: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'TestAgent/1.0',
    'x-forwarded-for': '203.0.113.1',
  };

  return new Headers({ ...defaults, ...overrides });
}

/**
 * Simulate a request object for testing route handlers.
 */
export function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Request {
  const { method = 'GET', url = 'http://localhost:3000', headers = {}, body } = options;

  return new Request(url, {
    method,
    headers: createMockHeaders(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
}
