// Sentry Node's auto-instrumentation only sees modules imported AFTER this
// one runs, so this must be the first import in src/index.ts — before any
// other module (db, sockets, sandbox clients, etc.) is loaded.
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

import * as Sentry from '@sentry/node';
import { getSentryOptions } from '@pagespace/lib/observability/sentry-env';
import { requireSentryDsn } from '@pagespace/lib/config/env-validation';

requireSentryDsn('realtime');

Sentry.init(getSentryOptions({
  nodeEnv: process.env.NODE_ENV,
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
}));
