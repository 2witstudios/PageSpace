import * as Sentry from "@sentry/nextjs";
import { getSentryOptions } from "@pagespace/lib/observability/sentry-env";

Sentry.init({
  ...getSentryOptions({
    nodeEnv: process.env.NODE_ENV,
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sendDefaultPii: process.env.NEXT_PUBLIC_SENTRY_SEND_DEFAULT_PII === 'true',
  }),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
