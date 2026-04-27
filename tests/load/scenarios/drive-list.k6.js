import http from 'k6/http';
import { check, sleep } from 'k6';
import { handleSummary } from '../scripts/k6-summary-handler.js';

export { handleSummary };

export const options = {
  vus: 20,
  duration: '60s',
  thresholds: {
    'http_req_duration{name:drives-list}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

const authRaw = open('../.k6-auth.json');
const auth = JSON.parse(authRaw);
if (!auth.sessionToken) {
  throw new Error('.k6-auth.json is present but missing sessionToken field');
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SESSION_COOKIE = `session=${auth.sessionToken}`;

export default function () {
  const commonHeaders = {
    Cookie: SESSION_COOKIE,
    'Content-Type': 'application/json',
  };

  // Fetch CSRF token
  const csrfRes = http.get(`${BASE_URL}/api/auth/csrf`, { headers: commonHeaders });
  check(csrfRes, { 'csrf status 200': (r) => r.status === 200 });
  const csrfToken = csrfRes.json('csrfToken') || '';

  // Drive list — pure read path, tagged for InfluxDB/Grafana per-endpoint metrics
  const drivesRes = http.get(`${BASE_URL}/api/drives`, {
    headers: {
      ...commonHeaders,
      'x-csrf-token': csrfToken,
    },
    tags: { name: 'drives-list' },
  });
  check(drivesRes, {
    'drives status 200': (r) => r.status === 200,
    'drives has array': (r) => Array.isArray(r.json('drives')),
  });

  sleep(1);
}
