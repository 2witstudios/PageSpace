export interface SentryEnv {
  nodeEnv?: string;
  dsn?: string;
}

export function getSentryOptions(env: SentryEnv) {
  const isDev = env.nodeEnv === 'development';
  return {
    dsn: env.dsn,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    enableLogs: true as const,
    sendDefaultPii: true as const,
  };
}
