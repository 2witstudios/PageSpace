import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { handleSummary } from '../scripts/k6-summary-handler.js';

export { handleSummary };

export const options = {
  vus: 10,
  duration: '60s',
  thresholds: {
    'http_req_duration{name:search}': ['p(95)<500'],
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

const SEARCH_TERMS = ['test', 'page', 'document', 'hello', 'world'];

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

  const term = randomItem(SEARCH_TERMS);
  const searchRes = http.get(
    `${BASE_URL}/api/search?q=${encodeURIComponent(term)}`,
    {
      headers: authedHeaders,
      tags: { name: 'search' },
    }
  );
  check(searchRes, {
    'search status 200': (r) => r.status === 200,
    'search has results': (r) => r.json('results') !== null,
  });

  sleep(1);
}
