import http from 'k6/http';
import { check, sleep } from 'k6';
import { handleSummary } from '../scripts/k6-summary-handler.js';

export { handleSummary };

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '60s', target: 10 },
    { duration: '30s', target: 25 },
    { duration: '60s', target: 25 },
    { duration: '30s', target: 0 },
  ],
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

  const authedHeaders = {
    ...commonHeaders,
    'x-csrf-token': csrfToken,
  };

  // List drives — tagged for threshold targeting
  const drivesRes = http.get(`${BASE_URL}/api/drives`, {
    headers: authedHeaders,
    tags: { name: 'drives-list' },
  });
  const drivesOk = check(drivesRes, {
    'drives status 200': (r) => r.status === 200,
    'drives has array': (r) => Array.isArray(r.json('drives')),
  });

  const drives = drivesOk ? drivesRes.json('drives') : [];
  const driveId = drives.length > 0 ? drives[0].id : (auth.driveId || null);

  if (driveId) {
    const pagesRes = http.get(`${BASE_URL}/api/pages?driveId=${driveId}`, {
      headers: authedHeaders,
      tags: { name: 'pages-list' },
    });
    check(pagesRes, { 'pages status 200': (r) => r.status === 200 });
  }

  sleep(1);
}
