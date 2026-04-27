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
    'http_req_duration{name:pages-list}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

let auth;
if (__ENV.K6_SESSION_TOKEN) {
  auth = { sessionToken: __ENV.K6_SESSION_TOKEN, driveId: __ENV.K6_DRIVE_ID || null };
} else {
  const authRaw = open('../.k6-auth.json');
  auth = JSON.parse(authRaw);
  if (!auth.sessionToken) {
    throw new Error('.k6-auth.json is present but missing sessionToken field');
  }
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
  // GET /api/drives returns a top-level JSON array
  const drivesRes = http.get(`${BASE_URL}/api/drives`, {
    headers: authedHeaders,
    tags: { name: 'drives-list' },
  });
  const drivesOk = check(drivesRes, {
    'drives status 200': (r) => r.status === 200,
    'drives has array': (r) => Array.isArray(r.json()),
  });

  const drives = drivesOk ? drivesRes.json() : [];
  const driveId = drives.length > 0 ? drives[0].id : (auth.driveId || null);

  if (driveId) {
    // Actual read endpoint is GET /api/drives/:id/pages
    const pagesRes = http.get(`${BASE_URL}/api/drives/${driveId}/pages`, {
      headers: authedHeaders,
      tags: { name: 'pages-list' },
    });
    check(pagesRes, { 'pages status 200': (r) => r.status === 200 });
  }

  sleep(1);
}
