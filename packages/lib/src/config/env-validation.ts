import { z } from 'zod';

/**
 * Server-side environment variable validation schema.
 * Validates required configuration at startup to prevent runtime failures.
 */
export const serverEnvSchema = z.object({
  // Database
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
      'DATABASE_URL must be a valid PostgreSQL connection string'
    ),

  // JWT Authentication
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1, 'JWT_ISSUER is required'),
  JWT_AUDIENCE: z.string().min(1, 'JWT_AUDIENCE is required'),

  // CSRF Protection
  CSRF_SECRET: z
    .string()
    .min(32, 'CSRF_SECRET must be at least 32 characters'),

  // Encryption
  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY must be at least 32 characters'),

  // Optional with defaults
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),

  // Optional URLs
  WEB_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_REALTIME_URL: z.string().url().optional(),
  INTERNAL_REALTIME_URL: z.string().url().optional(),

  // Optional OAuth
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),

  // Optional AI keys
  GOOGLE_AI_DEFAULT_API_KEY: z.string().optional(),
  OPENROUTER_DEFAULT_API_KEY: z.string().optional(),

  // Optional monitoring
  MONITORING_INGEST_KEY: z.string().optional(),
  MONITORING_INGEST_PATH: z.string().optional(),

  // Optional Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
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
