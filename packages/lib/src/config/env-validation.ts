import { z } from 'zod';

/**
 * Server-side environment variable validation schema.
 * Validates required configuration at startup to prevent runtime failures.
 * In test environment, CSRF_SECRET and ENCRYPTION_KEY are optional.
 */
export const serverEnvSchema = z
  .object({
    // Database
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
        'DATABASE_URL must be a valid PostgreSQL connection string'
      ),

    // CSRF Protection (required in production/development, optional in test)
    CSRF_SECRET: z.string().optional(),

    // Encryption (required in production/development, optional in test)
    ENCRYPTION_KEY: z.string().optional(),

    // Optional with defaults
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    LOG_LEVEL: z
      .enum(['debug', 'info', 'warn', 'error'])
      .default('info'),

    // Optional URLs
    WEB_APP_URL: z.string().url().optional().or(z.literal('')),
    NEXT_PUBLIC_REALTIME_URL: z.string().url().optional().or(z.literal('')),
    INTERNAL_REALTIME_URL: z.string().url().optional().or(z.literal('')),

    // Optional OAuth
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal('')),

    // Optional AI keys
    GOOGLE_AI_DEFAULT_API_KEY: z.string().optional(),
    OPENROUTER_DEFAULT_API_KEY: z.string().optional(),

    // Optional monitoring
    MONITORING_INGEST_KEY: z.string().optional(),
    MONITORING_INGEST_PATH: z.string().optional(),
    MONITORING_INGEST_DISABLED: z.enum(['true', 'false']).optional(),

    // Optional OAuth state
    OAUTH_STATE_SECRET: z.string().min(32).optional(),
    APPLE_SERVICE_ID: z.string().min(1).optional(),

    // Optional Stripe
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

    // Optional real-time / cron / cookie
    REALTIME_BROADCAST_SECRET: z.string().min(1).optional(),
    CRON_SECRET: z.string().min(1).optional(),
    COOKIE_DOMAIN: z.string().min(1).optional(),

    // Agent code execution global kill-switch (default OFF). Accept any string so
    // a stray value (e.g. CODE_EXECUTION_ENABLED=0) never fails app-wide env
    // validation; isCodeExecutionEnabled() enables only on the exact value 'true'.
    CODE_EXECUTION_ENABLED: z.string().optional(),

    // Server-held secret keying the sandbox session-key HMAC (see
    // services/sandbox/session-key.ts). A configured value must be >= 32 chars,
    // but a blank placeholder (SANDBOX_SESSION_SECRET=) is accepted — mirroring
    // the URL vars' `.or(z.literal(''))` — so an empty value disables sandbox
    // acquisition (the lifecycle layer fails closed) rather than failing
    // app-wide env validation at startup.
    SANDBOX_SESSION_SECRET: z.string().min(32).optional().or(z.literal('')),

    // Vercel Sandbox credentials for the code-execution adapter. All three are
    // optional: when present they authenticate the @vercel/sandbox client
    // explicitly (local dev / non-Vercel hosts); when absent the SDK falls back
    // to the OIDC token Vercel injects automatically. A partial triad never
    // half-authenticates (resolveVercelCredentials requires all three).
    VERCEL_TOKEN: z.string().min(1).optional(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
    VERCEL_PROJECT_ID: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    // In non-test environments, require CSRF_SECRET and ENCRYPTION_KEY
    if (data.NODE_ENV !== 'test') {
      if (!data.CSRF_SECRET || data.CSRF_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CSRF_SECRET must be at least 32 characters',
          path: ['CSRF_SECRET'],
        });
      }
      if (!data.ENCRYPTION_KEY || data.ENCRYPTION_KEY.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ENCRYPTION_KEY must be at least 32 characters',
          path: ['ENCRYPTION_KEY'],
        });
      }
    }

  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Validates environment variables against the schema.
 * @throws Error with descriptive message if validation fails
 */
export const validateEnv = (): ServerEnv => {
  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Environment validation failed:\n${errors}\n\nPlease check your .env file and ensure all required variables are set.`
    );
  }

  return result.data;
};

/**
 * Returns array of validation error messages without throwing.
 * Useful for health checks and diagnostics.
 */
export const getEnvErrors = (): string[] => {
  const result = serverEnvSchema.safeParse(process.env);

  if (result.success) {
    return [];
  }

  return result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`
  );
};

/**
 * Returns true if environment is valid, false otherwise.
 * Useful for conditional logic without throwing.
 */
export const isEnvValid = (): boolean => {
  const result = serverEnvSchema.safeParse(process.env);
  return result.success;
};

// Cached validated env - validated once on first access
let cachedEnv: ServerEnv | null = null;

/**
 * Returns validated environment, caching the result.
 * Validates only on first call, subsequent calls return cached result.
 */
export const getValidatedEnv = (): ServerEnv => {
  if (!cachedEnv) {
    cachedEnv = validateEnv();
  }
  return cachedEnv;
};
