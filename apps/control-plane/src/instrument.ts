// Sentry Node's auto-instrumentation only sees modules imported AFTER this
// one runs, so this must be the first import in src/index.ts — before
// fastify, drizzle, or any route module is loaded.
import * as Sentry from '@sentry/node';
import { getSentryOptions } from '@pagespace/lib/observability/sentry-env';
import { requireSentryDsn } from '@pagespace/lib/config/env-validation';

requireSentryDsn('control-plane');

Sentry.init(getSentryOptions({
  nodeEnv: process.env.NODE_ENV,
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
}));
