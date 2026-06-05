import * as Sentry from "@sentry/nextjs";
import { getSentryOptions } from "./src/lib/sentry/config";

Sentry.init({
  ...getSentryOptions({
    nodeEnv: process.env.NODE_ENV,
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  }),
  integrations: [Sentry.replayIntegration()],
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
