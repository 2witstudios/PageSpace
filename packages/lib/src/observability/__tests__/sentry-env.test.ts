import { describe, it, expect } from 'vitest';
import { getSentryOptions } from '../sentry-env';

describe('getSentryOptions', () => {
  it('sets tracesSampleRate to 1.0 in development', () => {
    const opts = getSentryOptions({ nodeEnv: 'development' });
    expect(opts.tracesSampleRate).toBe(1.0);
  });

  it('sets tracesSampleRate to 0.1 in production', () => {
    const opts = getSentryOptions({ nodeEnv: 'production' });
    expect(opts.tracesSampleRate).toBe(0.1);
  });

  it('sets tracesSampleRate to 0.1 when nodeEnv is undefined', () => {
    const opts = getSentryOptions({});
    expect(opts.tracesSampleRate).toBe(0.1);
  });

  it('passes dsn through unchanged', () => {
    const dsn = 'https://abc123@o0.ingest.sentry.io/0';
    const opts = getSentryOptions({ dsn });
    expect(opts.dsn).toBe(dsn);
  });

  it('passes undefined dsn through', () => {
    const opts = getSentryOptions({});
    expect(opts.dsn).toBeUndefined();
  });

  it('always sets enableLogs to true', () => {
    expect(getSentryOptions({ nodeEnv: 'development' }).enableLogs).toBe(true);
    expect(getSentryOptions({ nodeEnv: 'production' }).enableLogs).toBe(true);
  });

  it('defaults sendDefaultPii to false for privacy safety', () => {
    expect(getSentryOptions({}).sendDefaultPii).toBe(false);
    expect(getSentryOptions({ nodeEnv: 'development' }).sendDefaultPii).toBe(false);
    expect(getSentryOptions({ nodeEnv: 'production' }).sendDefaultPii).toBe(false);
  });

  it('enables sendDefaultPii when explicitly opted in', () => {
    expect(getSentryOptions({ sendDefaultPii: true }).sendDefaultPii).toBe(true);
  });
});
