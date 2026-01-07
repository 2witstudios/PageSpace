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
 *   # Create a test user in the database before running:
 *   # Email: loadtest@example.com
 *   # Password: LoadTest123!
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
const csrfLatency = new Trend('csrf_latency');
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
    // Performance thresholds (based on baseline results with bcrypt)
    'login_latency': ['p(95)<1500'],           // 95th percentile < 1500ms (bcrypt is slow by design)
    'refresh_latency': ['p(95)<200'],          // 95th percentile < 200ms
    'token_validation_latency': ['p(95)<100'], // 95th percentile < 100ms
    'csrf_latency': ['p(95)<50'],              // 95th percentile < 50ms
    'auth_error_rate': ['rate<0.30'],          // Less than 30% errors (refresh token consumption expected)
    'http_req_duration': ['p(95)<1500'],       // Overall p95 < 1500ms (accounts for bcrypt)
  },
};

// Configuration from environment
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = __ENV.TEST_EMAIL || 'loadtest@example.com';
const TEST_PASSWORD = __ENV.TEST_PASSWORD || 'LoadTest123!';

/**
 * Setup function - runs once before the test
 * Validates that the test user exists
 */
export function setup() {
  console.log(`Running auth baseline against ${BASE_URL}`);
  console.log(`Using test email: ${TEST_EMAIL}`);

  // Test that we can reach the server
  const healthCheck = http.get(`${BASE_URL}/api/health`, { timeout: '5s' });
  if (healthCheck.status !== 200 && healthCheck.status !== 404) {
    console.warn(`Health check returned ${healthCheck.status} - server may not be running`);
  }

  return {
    baseUrl: BASE_URL,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  };
}

/**
 * Main test function - runs for each virtual user iteration
 */
export default function (data) {
  // Each VU gets its own cookie jar (default k6 behavior per iteration)
  const jar = http.cookieJar();

  let loginCsrfToken = null;
  let isLoggedIn = false;

  // Step 1: Fetch Login CSRF Token
  group('CSRF Token Fetch', () => {
    const csrfStart = Date.now();

    const csrfResponse = http.get(`${data.baseUrl}/api/auth/login-csrf`, {
      tags: { name: 'login-csrf' },
    });

    const csrfDuration = Date.now() - csrfStart;
    csrfLatency.add(csrfDuration);

    const csrfSuccess = check(csrfResponse, {
      'csrf status is 200': (r) => r.status === 200,
      'csrf returns token': (r) => {
        try {
          const body = JSON.parse(r.body);
          loginCsrfToken = body.csrfToken;
          return !!loginCsrfToken;
        } catch {
          return false;
        }
      },
    });

    // Manually set the login_csrf cookie for the /api/auth path
    // k6's automatic cookie handling may not work with path-restricted cookies
    if (loginCsrfToken) {
      jar.set(data.baseUrl, 'login_csrf', loginCsrfToken, { path: '/api/auth' });
    }

    if (!csrfSuccess) {
      authErrorRate.add(1);
      console.log(`CSRF fetch failed: status ${csrfResponse.status}, body: ${csrfResponse.body}`);
      return;
    } else {
      authErrorRate.add(0);
    }
  });

  // Don't proceed if we didn't get a CSRF token
  if (!loginCsrfToken) {
    console.log('No CSRF token, skipping login');
    return;
  }

  sleep(0.5);

  // Step 2: Login with CSRF token
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
          'X-Login-CSRF-Token': loginCsrfToken,
        },
        tags: { name: 'login' },
      }
    );

    const loginDuration = Date.now() - loginStart;
    loginLatency.add(loginDuration);

    // Parse and store cookies from response
    // k6 may not automatically handle all Set-Cookie headers correctly
    const setCookieHeader = loginResponse.headers['Set-Cookie'];
    if (setCookieHeader) {
      // Handle both single string and array of cookies
      const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      cookies.forEach(cookie => {
        const parts = cookie.split(';')[0].split('=');
        if (parts.length >= 2) {
          const name = parts[0];
          const value = parts.slice(1).join('='); // Handle values with '=' in them
          jar.set(data.baseUrl, name, value, { path: '/' });
        }
      });
    }

    const loginSuccess = check(loginResponse, {
      'login status is 200': (r) => r.status === 200,
      'login returns user id': (r) => {
        try {
          const body = JSON.parse(r.body);
          return !!body.id;
        } catch {
          return false;
        }
      },
    });

    if (!loginSuccess) {
      authErrorRate.add(1);
      if (loginResponse.status === 403) {
        console.log(`Login CSRF rejected: ${loginResponse.body}`);
      } else if (loginResponse.status === 401) {
        console.log(`Login auth failed (check test user exists): ${loginResponse.body}`);
      } else if (loginResponse.status === 429) {
        console.log(`Login rate limited: ${loginResponse.body}`);
      } else {
        console.log(`Login failed: status ${loginResponse.status}, body: ${loginResponse.body}`);
      }
    } else {
      authErrorRate.add(0);
      isLoggedIn = true;
    }
  });

  // Don't proceed if login failed
  if (!isLoggedIn) {
    sleep(1);
    return;
  }

  sleep(1);

  // Step 3: Test protected endpoint (token validation)
  group('Token Validation', () => {
    const validationStart = Date.now();

    // Use /api/drives as the protected endpoint test
    const protectedResponse = http.get(
      `${data.baseUrl}/api/drives`,
      {
        tags: { name: 'drives' },
        // Cookies are automatically sent from the jar
      }
    );

    const validationDuration = Date.now() - validationStart;
    tokenValidationLatency.add(validationDuration);

    const validationSuccess = check(protectedResponse, {
      'protected endpoint status is 200': (r) => r.status === 200,
      'returns drives array': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body) || Array.isArray(body.drives);
        } catch {
          return false;
        }
      },
    });

    if (!validationSuccess) {
      authErrorRate.add(1);
      console.log(`Protected endpoint failed: status ${protectedResponse.status}`);
    } else {
      authErrorRate.add(0);
    }
  });

  sleep(1);

  // Step 4: Test refresh endpoint
  group('Token Refresh', () => {
    const refreshStart = Date.now();

    const refreshResponse = http.post(
      `${data.baseUrl}/api/auth/refresh`,
      null, // No body needed, uses cookie
      {
        headers: {
          'Content-Type': 'application/json',
        },
        tags: { name: 'refresh' },
      }
    );

    const refreshDuration = Date.now() - refreshStart;
    refreshLatency.add(refreshDuration);

    const refreshSuccess = check(refreshResponse, {
      'refresh status is 200': (r) => r.status === 200,
      'refresh returns success message': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.message === 'Token refreshed successfully';
        } catch {
          return false;
        }
      },
      'refresh sets new cookies': (r) => {
        const setCookie = r.headers['Set-Cookie'];
        return setCookie && setCookie.includes('accessToken');
      },
    });

    if (!refreshSuccess) {
      authErrorRate.add(1);
      if (refreshResponse.status === 429) {
        console.log(`Refresh rate limited: ${refreshResponse.body}`);
      } else {
        console.log(`Refresh failed: status ${refreshResponse.status}`);
      }
    } else {
      authErrorRate.add(0);
    }
  });

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
      testEmail: TEST_EMAIL,
    },
    metrics: {
      csrf: {
        p50: data.metrics.csrf_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.csrf_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.csrf_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.csrf_latency?.values?.avg || 0,
        count: data.metrics.csrf_latency?.values?.count || 0,
      },
      login: {
        p50: data.metrics.login_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.login_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.login_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.login_latency?.values?.avg || 0,
        count: data.metrics.login_latency?.values?.count || 0,
      },
      refresh: {
        p50: data.metrics.refresh_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.refresh_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.refresh_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.refresh_latency?.values?.avg || 0,
        count: data.metrics.refresh_latency?.values?.count || 0,
      },
      tokenValidation: {
        p50: data.metrics.token_validation_latency?.values?.['p(50)'] || 0,
        p95: data.metrics.token_validation_latency?.values?.['p(95)'] || 0,
        p99: data.metrics.token_validation_latency?.values?.['p(99)'] || 0,
        avg: data.metrics.token_validation_latency?.values?.avg || 0,
        count: data.metrics.token_validation_latency?.values?.count || 0,
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
    '  CSRF Token Fetch:',
    `    p50: ${data.metrics.csrf_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.csrf_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.csrf_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    `    count: ${data.metrics.csrf_latency?.values?.count || 0}`,
    '',
    '  Login Latency:',
    `    p50: ${data.metrics.login_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.login_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.login_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    `    count: ${data.metrics.login_latency?.values?.count || 0}`,
    '',
    '  Token Validation Latency:',
    `    p50: ${data.metrics.token_validation_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.token_validation_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.token_validation_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    `    count: ${data.metrics.token_validation_latency?.values?.count || 0}`,
    '',
    '  Refresh Latency:',
    `    p50: ${data.metrics.refresh_latency?.values?.['p(50)']?.toFixed(2) || 'N/A'}ms`,
    `    p95: ${data.metrics.refresh_latency?.values?.['p(95)']?.toFixed(2) || 'N/A'}ms`,
    `    p99: ${data.metrics.refresh_latency?.values?.['p(99)']?.toFixed(2) || 'N/A'}ms`,
    `    count: ${data.metrics.refresh_latency?.values?.count || 0}`,
    '',
    '  Error Rate: ' + ((data.metrics.auth_error_rate?.values?.rate || 0) * 100).toFixed(2) + '%',
    '  Total Requests: ' + (data.metrics.http_reqs?.values?.count || 0),
    '',
    '  Thresholds: ' + (Object.entries(data.metrics)
      .filter(([_, v]) => v.thresholds)
      .every(([_, v]) => Object.values(v.thresholds).every(t => t.ok)) ? 'PASSED' : 'FAILED'),
    '',
    '='.repeat(60),
    '',
  ];

  return lines.join('\n');
}
