import * as Sentry from "@sentry/nextjs";
import { getSentryOptions } from "@pagespace/lib/observability/sentry-env";
import { isCapacitorApp } from "@/lib/capacitor-bridge";
import { clientReplaySampling } from "@/lib/observability/client-replay";

// Capacitor injects its bridge at document start, so native detection is ready here.
const replay = clientReplaySampling({ isNative: isCapacitorApp() });

Sentry.init({
  ...getSentryOptions({
    nodeEnv: process.env.NODE_ENV,
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sendDefaultPii: process.env.NEXT_PUBLIC_SENTRY_SEND_DEFAULT_PII === 'true',
  }),
  integrations: replay.enabled ? [Sentry.replayIntegration()] : [],
  replaysSessionSampleRate: replay.replaysSessionSampleRate,
  replaysOnErrorSampleRate: replay.replaysOnErrorSampleRate,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
