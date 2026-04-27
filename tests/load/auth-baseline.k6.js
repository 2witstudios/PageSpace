import http from 'k6/http';
import { check, sleep } from 'k6';
import { handleSummary } from './scripts/k6-summary-handler.js';

export { handleSummary };

export const options = {
  vus: __ENV.K6_VUS ? parseInt(__ENV.K6_VUS) : 5,
  duration: __ENV.K6_DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

// Auth: prefer K6_SESSION_TOKEN env var (CI), fall back to .k6-auth.json (local dev)
let auth;
if (__ENV.K6_SESSION_TOKEN) {
  auth = { sessionToken: __ENV.K6_SESSION_TOKEN, driveId: __ENV.K6_DRIVE_ID || null };
} else {
  // open() only works at init time — aborts immediately if file is missing
  const authRaw = open('./.k6-auth.json');
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

  // 1. Fetch CSRF token
  const csrfRes = http.get(`${BASE_URL}/api/auth/csrf`, { headers: commonHeaders });
  check(csrfRes, { 'csrf status 200': (r) => r.status === 200 });
  const csrfToken = csrfRes.json('csrfToken') || '';

  const authedHeaders = {
    ...commonHeaders,
    'x-csrf-token': csrfToken,
  };

  // 2. List drives — GET /api/drives returns a top-level JSON array
  const drivesRes = http.get(`${BASE_URL}/api/drives`, { headers: authedHeaders });
  const drivesOk = check(drivesRes, {
    'drives status 200': (r) => r.status === 200,
    'drives has array': (r) => Array.isArray(r.json()),
  });

  const drives = drivesOk ? drivesRes.json() : [];
  const driveId = drives.length > 0 ? drives[0].id : (auth.driveId || null);

  // 3. List pages for first drive — actual read endpoint is GET /api/drives/:id/pages
  if (driveId) {
    const pagesRes = http.get(`${BASE_URL}/api/drives/${driveId}/pages`, {
      headers: authedHeaders,
    });
    check(pagesRes, { 'pages status 200': (r) => r.status === 200 });
  }

  sleep(1);
}
