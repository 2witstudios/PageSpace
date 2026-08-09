export interface SentryEnv {
  nodeEnv?: string;
  dsn?: string;
  // Opt in via SENTRY_SEND_DEFAULT_PII=true; defaults false to avoid sending IPs/cookies (GDPR/CCPA).
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
