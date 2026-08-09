import * as Sentry from "@sentry/nextjs";
import { getSentryOptions } from "@pagespace/lib/observability/sentry-env";

Sentry.init(getSentryOptions({
  nodeEnv: process.env.NODE_ENV,
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
}));
