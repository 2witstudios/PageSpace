import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { parseWorkerEnv } from '../parse-worker-env.js';

const KEY = 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=';
const base = { BROWSER_SESSION_ID: 'bws_abc123', BROWSER_CONTROL_PUBLIC_KEY: KEY };

describe('parseWorkerEnv', () => {
  it('reads a minimal environment with safe defaults', () => {
    assert({
      given: 'only a session id and a control key',
      should: 'listen on loopback port 8080 for the public web, with default profile root and browser',
      actual: parseWorkerEnv(base),
      expected: {
        ok: true,
        config: { sessionId: 'bws_abc123', controlPublicKey: KEY, allowedOrigins: null, host: '127.0.0.1', port: 8080, profileRoot: null, executablePath: null },
      },
    });
  });

  it('reads every optional setting', () => {
    assert({
      given: 'pinned origins, a host, a port, a profile root and a browser path',
      should: 'carry each through',
      actual: parseWorkerEnv({
        ...base,
        BROWSER_ALLOWED_ORIGINS: '["https://example.com"]',
        BROWSER_WORKER_HOST: '0.0.0.0',
        BROWSER_WORKER_PORT: '0',
        BROWSER_PROFILE_ROOT: '/var/browser',
        BROWSER_EXECUTABLE_PATH: '/opt/chrome',
      }),
      expected: {
        ok: true,
        config: { sessionId: 'bws_abc123', controlPublicKey: KEY, allowedOrigins: ['https://example.com'], host: '0.0.0.0', port: 0, profileRoot: '/var/browser', executablePath: '/opt/chrome' },
      },
    });
  });

  it('refuses to start without a session or a key, or with an unreadable setting', () => {
    const cases = [
      {},
      { BROWSER_CONTROL_PUBLIC_KEY: KEY },
      { ...base, BROWSER_SESSION_ID: 'has spaces' },
      { BROWSER_SESSION_ID: 'bws_abc123', BROWSER_CONTROL_PUBLIC_KEY: '  ' },
      { ...base, BROWSER_CONTROL_PUBLIC_KEY: 'not base64!' },
      { ...base, BROWSER_ALLOWED_ORIGINS: '{"a":1}' },
      { ...base, BROWSER_ALLOWED_ORIGINS: '[1]' },
      { ...base, BROWSER_ALLOWED_ORIGINS: 'https://example.com' },
      { ...base, BROWSER_WORKER_PORT: '65536' },
      { ...base, BROWSER_WORKER_PORT: 'http' },
    ];
    assert({
      given: 'missing or invalid session ids, keys, origins and ports',
      should: 'refuse with the reason — a worker without a pinned key must not start',
      actual: cases.map((env) => parseWorkerEnv(env)),
      expected: [
        { ok: false, reason: 'session-id-missing' },
        { ok: false, reason: 'session-id-missing' },
        { ok: false, reason: 'session-id-invalid' },
        { ok: false, reason: 'control-key-missing' },
        { ok: false, reason: 'control-key-invalid' },
        { ok: false, reason: 'allowed-origins-invalid' },
        { ok: false, reason: 'allowed-origins-invalid' },
        { ok: false, reason: 'allowed-origins-invalid' },
        { ok: false, reason: 'port-invalid' },
        { ok: false, reason: 'port-invalid' },
      ],
    });
  });
});
