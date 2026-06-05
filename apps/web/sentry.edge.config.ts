import * as Sentry from "@sentry/nextjs";
import { getSentryOptions } from "./src/lib/sentry/config";

Sentry.init(getSentryOptions({
  nodeEnv: process.env.NODE_ENV,
  dsn: process.env.SENTRY_DSN,
}));
