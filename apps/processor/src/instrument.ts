// Sentry Node's auto-instrumentation only sees modules imported AFTER this
// one runs, so this must be the first import in src/server.ts — before
// express and any route module is loaded.
import dotenv from 'dotenv';
dotenv.config();

import * as Sentry from '@sentry/node';
import { getSentryOptions } from '@pagespace/lib/observability/sentry-env';
import { requireSentryDsn } from '@pagespace/lib/config/env-validation';

requireSentryDsn('processor');

Sentry.init(getSentryOptions({
  nodeEnv: process.env.NODE_ENV,
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
}));
