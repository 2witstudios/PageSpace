import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let onPrem = false;
vi.mock('../../../deployment-mode', () => ({
  isOnPrem: () => onPrem,
}));

import { isAppLogsNatsConfigured, resolveAppLogsNatsUrl } from '../app-logs-env';

const ORIGINAL_ENV = { ...process.env };

describe('isAppLogsNatsConfigured', () => {
  beforeEach(() => {
    onPrem = false;
    delete process.env.FLY_LOGS_NATS_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('is false with no token configured', () => {
    expect(isAppLogsNatsConfigured()).toBe(false);
  });

  it('is true once a token is set (tenant/cloud deployment)', () => {
    process.env.FLY_LOGS_NATS_TOKEN = 'a-real-token';
    expect(isAppLogsNatsConfigured()).toBe(true);
  });

  // Regression: an external Fly integration must be gated on `isOnPrem()`,
  // never left to the token alone — an on-prem deployment that happens to
  // have FLY_LOGS_NATS_TOKEN set in its environment (a copy-pasted .env, a
  // stale secret) must still never attempt to reach Fly's firehose.
  it('is false on an on-prem deployment even with a token configured', () => {
    onPrem = true;
    process.env.FLY_LOGS_NATS_TOKEN = 'a-real-token';
    expect(isAppLogsNatsConfigured()).toBe(false);
  });

  it('the fixed firehose URL is unaffected by deployment mode', () => {
    onPrem = true;
    expect(resolveAppLogsNatsUrl()).toBe('nats://[fdaa::3]:4223');
  });
});
