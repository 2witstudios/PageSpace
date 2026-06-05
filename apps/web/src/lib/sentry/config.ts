export interface SentryEnv {
  nodeEnv?: string;
  dsn?: string;
  // Set to true only when explicitly opted in (e.g. SENTRY_SEND_DEFAULT_PII=true).
  // Defaults to false to avoid capturing IP addresses, cookies, and user context
  // without an explicit decision — important for GDPR/CCPA compliance.
  sendDefaultPii?: boolean;
}

export function getSentryOptions(env: SentryEnv) {
  const isDev = env.nodeEnv === 'development';
  return {
    dsn: env.dsn,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    enableLogs: true as const,
    sendDefaultPii: env.sendDefaultPii ?? false,
  };
}
