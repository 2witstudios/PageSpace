/**
 * Auth Performance Baseline - k6 Load Test
 *
 * Establishes performance baselines for authentication endpoints
 * before security enhancements are applied.
 *
 * Install k6: https://k6.io/docs/getting-started/installation/
 *
 * Usage:
 *   # Run baseline test
 *   k6 run tests/load/auth-baseline.k6.js
 *
 *   # Run with custom options
 *   k6 run --vus 10 --duration 30s tests/load/auth-baseline.k6.js
 *
 *   # Export results to JSON
 *   k6 run --out json=results/baseline-$(date +%Y-%m-%d).json tests/load/auth-baseline.k6.js
 *
 * Prerequisites:
 *   # Ensure output directory exists before running (k6 doesn't create it)
 *   mkdir -p tests/load/results
 *
 * Environment Variables:
 *   BASE_URL - Target URL (default: http://localhost:3000)
 *   TEST_EMAIL - Test user email
 *   TEST_PASSWORD - Test user password
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics for detailed analysis
const loginLatency = new Trend('login_latency');
const refreshLatency = new Trend('refresh_latency');
const tokenValidationLatency = new Trend('token_validation_latency');
const authErrorRate = new Rate('auth_error_rate');

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 5 },   // Ramp up to 5 users
    { duration: '1m', target: 10 },   // Hold at 10 users
    { duration: '30s', target: 20 },  // Spike to 20 users
    { duration: '1m', target: 10 },   // Back to 10 users
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    // Performance thresholds (adjust based on baseline results)
    'login_latency': ['p(95)<500'],           // 95th percentile < 500ms
    'refresh_latency': ['p(95)<200'],          // 95th percentile < 200ms
    'token_validation_latency': ['p(95)<50'],  // 95th percentile < 50ms
    'auth_error_rate': ['rate<0.01'],          // Less than 1% errors
    'http_req_duration': ['p(95)<500'],        // Overall p95 < 500ms
  },
};

// Configuration from environment
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = __ENV.TEST_EMAIL || 'loadtest@example.com';
const TEST_PASSWORD = __ENV.TEST_PASSWORD || 'LoadTest123!';

// Shared state for tokens
let accessToken = null;
let refreshToken = null;

/**
 * Setup function - runs once before the test
 */
export function setup() {
  console.log(`Running auth baseline against ${BASE_URL}`);
  console.log('Note: Ensure a test user exists before running');

  return {
    baseUrl: BASE_URL,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  };
}

/**
 * Main test function - runs for each virtual user
 */
export default function (data) {
  // Test login endpoint
  group('Login Flow', () => {
    const loginStart = Date.now();

    const loginResponse = http.post(
      `${data.baseUrl}/api/auth/login`,
      JSON.stringify({
        email: data.email,
        password: data.password,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const loginDuration = Date.now() - loginStart;
    loginLatency.add(loginDuration);

    const loginSuccess = check(loginResponse, {
      'login status is 200': (r) => r.status === 200,
      'login returns access token': (r) => {
        try {
          const body = JSON.parse(r.body);
          accessToken = body.accessToken;
          refreshToken = body.refreshToken;
          return !!accessToken;
        } catch {
          return false;
        }
      },
    });

    if (!loginSuccess) {
      authErrorRate.add(1);
      console.log(`Login failed: status ${loginResponse.status}`);
    } else {
      authErrorRate.add(0);
    }
  });

  sleep(1);

  // Test protected endpoint (token validation)
  if (accessToken) {
    group('Token Validation', () => {
      const validationStart = Date.now();

      const protectedResponse = http.get(
        `${data.baseUrl}/api/user/profile`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const validationDuration = Date.now() - validationStart;
      tokenValidationLatency.add(validationDuration);

      const validationSuccess = check(protectedResponse, {
        'protected endpoint status is 200': (r) => r.status === 200,
        'returns user data': (r) => {
          try {
            const body = JSON.parse(r.body);
            return !!body.id || !!body.email;
          } catch {
            return false;
          }
        },
      });

      if (!validationSuccess) {
        authErrorRate.add(1);
      } else {
        authErrorRate.add(0);
      }
    });
  }

  sleep(1);

  // Test refresh endpoint
  if (refreshToken) {
    group('Token Refresh', () => {
      const refreshStart = Date.now();

      const refreshResponse = http.post(
        `${data.baseUrl}/api/auth/refresh`,
        JSON.stringify({
          refreshToken: refreshToken,
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const refreshDuration = Date.now() - refreshStart;
      refreshLatency.add(refreshDuration);

      const refreshSuccess = check(refreshResponse, {
        'refresh status is 200': (r) => r.status === 200,
        'refresh returns new tokens': (r) => {
          try {
            const body = JSON.parse(r.body);
            if (body.accessToken) {
              accessToken = body.accessToken;
            }
            if (body.refreshToken) {
              refreshToken = body.refreshToken;
            }
            return !!body.accessToken;
          } catch {
            return false;
          }
        },
      });

      if (!refreshSuccess) {
        authErrorRate.add(1);
      } else {
        authErrorRate.add(0);
      }
    });
  }

  sleep(2);
}

/**
 * Teardown function - runs once after the test
 */
export function teardown(data) {
  console.log('Auth baseline test completed');
  console.log('Review the results to establish performance thresholds');
}

/**
 * Handle summary - generate custom report
 */
export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    configuration: {
      baseUrl: BASE_URL,
      stages: options.stages,
    },
    metrics: {
      login: {
        p50: data.metrics.login_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.login_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.login_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.login_latency?.values?.avg || 0,
      },
      refresh: {
        p50: data.metrics.refresh_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.refresh_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.refresh_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.refresh_latency?.values?.avg || 0,
      },
      tokenValidation: {
        p50: data.metrics.token_validation_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.token_validation_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.token_validation_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.token_validation_latency?.values?.avg || 0,
      },
      errorRate: data.metrics.auth_error_rate?.values?.rate || 0,
      totalRequests: data.metrics.http_reqs?.values?.count || 0,
    },
    thresholds: {
      passed: Object.entries(data.metrics)
        .filter(([_, v]) => v.thresholds)
        .every(([_, v]) => Object.values(v.thresholds).every(t => t.ok)),
    },
  };

  return {
    'stdout': textSummary(data),
    'tests/load/results/baseline-latest.json': JSON.stringify(summary, null, 2),
  };
}

/**
 * Text summary helper
 */
function textSummary(data) {
  const lines = [
    '',
    '='.repeat(60),
    '  AUTH PERFORMANCE BASELINE RESULTS',
    '='.repeat(60),
    '',
    '  Login Latency:',
    `    p50: ${data.metrics.login_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.login_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.login_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    '',
    '  Refresh Latency:',
    `    p50: ${data.metrics.refresh_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.refresh_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.refresh_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    '',
    '  Token Validation Latency:',
    `    p50: ${data.metrics.token_validation_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.token_validation_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.token_validation_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    '',
    '  Error Rate: ' + ((data.metrics.auth_error_rate?.values?.rate || 0) * 100).toFixed(2) + '%',
    '  Total Requests: ' + (data.metrics.http_reqs?.values?.count || 0),
    '',
    '='.repeat(60),
    '',
  ];

  return lines.join('\n');
}
