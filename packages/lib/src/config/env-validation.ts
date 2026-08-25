import { z } from 'zod';
import { isOnPrem } from '../deployment-mode';

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

    // Admin Postgres (trust plane) — dedicated database for the tamper-evident
    // security audit chain and related admin/audit tables, isolated from the app
    // DB in every deployment mode. Optional at the schema level: the mode
    // decision (dedicated / break-glass / main-db / fail) is owned by
    // resolveAdminDbMode at adminDb init, not here, so non-audit code paths can
    // still validate env. An EMPTY string is explicitly accepted (via
    // `.or(z.literal(''))`) and treated as UNSET — resolveAdminDbMode already
    // maps '' → unset (→ the silent 'main-db' default). Rejecting '' here would
    // crash the process at boot (instrumentation.ts calls validateEnv) BEFORE
    // the mode decision runs, defeating the incident fix for the common
    // `ADMIN_DATABASE_URL=` blank-value form. A NON-empty value must still be a
    // postgres URL.
    ADMIN_DATABASE_URL: z
      .string()
      .min(1, 'ADMIN_DATABASE_URL must not be empty when set')
      .refine(
        (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
        'ADMIN_DATABASE_URL must be a valid PostgreSQL connection string'
      )
      .optional()
      .or(z.literal('')),
    ADMIN_DATABASE_SSL: z.enum(['true', 'false']).optional(),
    ADMIN_DB_POOL_MAX: z.coerce.number().int().positive().optional(),

    // GDPR eraser identity (#890 Phase 2, leaf 6): the web pseudonymization
    // route connects to the Admin PG as admin_gdpr_eraser_user through this
    // URL. Optional at the schema level — when unset, the pseudonymize route
    // refuses (503) via the eraser client, never at app boot. An EMPTY string is
    // accepted and treated as UNSET, mirroring ADMIN_DATABASE_URL and the eraser
    // client (resolveAdminEraserDbMode maps '' → unavailable): a blank
    // `ADMIN_ERASER_DATABASE_URL=` must not crash boot.
    ADMIN_ERASER_DATABASE_URL: z
      .string()
      .min(1, 'ADMIN_ERASER_DATABASE_URL must not be empty when set')
      .refine(
        (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
        'ADMIN_ERASER_DATABASE_URL must be a valid PostgreSQL connection string'
      )
      .optional()
      .or(z.literal('')),

    // Break-glass rollback ONLY: arms the fallback that permits audit writes to
    // the main DB (which must alert loudly) when the Admin PG is unavailable.
    // Never a supported steady state. Accept any string so a stray value (e.g.
    // ADMIN_DB_BREAK_GLASS=1) never fails app-wide env validation; consumers
    // arm break-glass only on the exact value 'true' (fail-closed otherwise).
    ADMIN_DB_BREAK_GLASS: z.string().optional(),

    // Opt-in trust-plane enforcement. When exactly 'true' AND ADMIN_DATABASE_URL
    // is unset, the adminDb mode is 'fail' (fail closed) instead of the silent
    // 'main-db' default. Set only in deployments that HAVE adopted the dedicated
    // Admin PG and want a missing URL to halt rather than fall back to the main
    // DB. Accept any string so a stray value never fails app-wide env
    // validation; consumers arm it only on the exact value 'true'.
    AUDIT_TRUST_PLANE_REQUIRED: z.string().optional(),

    // ClickHouse analytics tier (#890 Phase 3) — off by default. Only the
    // exact value CLICKHOUSE_ENABLED='true' turns it on (accept any string so
    // a stray value never fails app-wide env validation; the exact-match gate
    // lives in observability/clickhouse-env.ts). All connection vars are
    // optional at the schema level: the three-state fail-fast (off → no CH /
    // on+configured → client / on+misconfigured → throw) is enforced by the
    // client shell at init, not here, so non-analytics code paths still
    // validate env. Credentials are server-side secrets — never NEXT_PUBLIC_,
    // placeholders only in .env.example.
    CLICKHOUSE_ENABLED: z.string().optional(),
    CLICKHOUSE_URL: z.string().optional(),
    CLICKHOUSE_HOST: z.string().optional(),
    CLICKHOUSE_USER: z.string().optional(),
    CLICKHOUSE_PASSWORD: z.string().optional(),
    CLICKHOUSE_DATABASE: z.string().optional(),

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

    // AI keys. OpenRouter powers the cloud model picker; OpenAI is required for
    // voice mode (direct api.openai.com). The rest are optional, kept for future
    // native (non-OpenRouter) provider routing.
    OPENROUTER_DEFAULT_API_KEY: z.string().optional(),
    OPENAI_DEFAULT_API_KEY: z.string().optional(),
    ANTHROPIC_DEFAULT_API_KEY: z.string().optional(),
    GOOGLE_AI_DEFAULT_API_KEY: z.string().optional(),
    XAI_DEFAULT_API_KEY: z.string().optional(),
    GLM_CODER_DEFAULT_API_KEY: z.string().optional(),
    MINIMAX_DEFAULT_API_KEY: z.string().optional(),

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

    // Fly Sprites API token (Bearer) for the code-execution driver. Optional: a
    // blank value disables sandbox provisioning (the driver fails closed with an
    // auth error surfaced as a provisioning failure) rather than failing app-wide
    // env validation. Read via resolveSpritesToken (services/sandbox/...).
    SPRITES_API_TOKEN: z.string().min(1).optional().or(z.literal('')),

    // Published-app hosting global kill-switch (default OFF). Accept any string so
    // a stray value (e.g. APP_HOSTING_ENABLED=0) never fails app-wide env
    // validation; isAppHostingEnabled() enables only on the exact value 'true'.
    APP_HOSTING_ENABLED: z.string().optional(),

    // Fly Machines org token (Bearer) for the published-app provisioner. Optional:
    // a blank value disables provisioning (the flaps client fails closed with an
    // auth error surfaced as a provisioning failure) rather than failing app-wide
    // env validation. Read via resolveFlyMachinesToken (services/app-hosting/...).
    FLY_MACHINES_ORG_TOKEN: z.string().min(1).optional().or(z.literal('')),

    // The ONE Fly network every published app is created on. Optional: unset falls
    // back to PUBLISHED_APPS_NETWORK_DEFAULT. This is an org-level override (e.g. a
    // separate staging network), never a per-app value — fly-replay cannot cross
    // networks, so all published apps must share one.
    PUBLISHED_APPS_NETWORK: z.string().optional(),

    // The apex published apps are served from (`<subdomain>.<apex>`). Optional in
    // the schema, but REQUIRED by the superRefine below once APP_HOSTING_ENABLED
    // is 'true' — unset only falls back to PUBLISHED_APPS_APEX_DEFAULT while
    // hosting is dark. Deliberately a DIFFERENT
    // apex from `*.pagespace.site`, which is not on the Public Suffix List — a
    // published app runs customer server code on its own origin, so sharing a
    // registrable domain with other published content would let one app set
    // cookies every other one sends. Read via resolvePublishedAppsApex.
    PUBLISHED_APPS_APEX: z.string().optional(),

    // The Fly app that terminates the published-apps apex, emits fly-replay, and
    // holds custom-domain certs. Optional: falls back to FLY_PROXY_APP_NAME and
    // then to APP_ROUTER_FLY_APP_DEFAULT. It MUST have been created on
    // PUBLISHED_APPS_NETWORK — fly-replay cannot cross Fly 6PN networks, and an
    // app's network is fixed at create time. See routing-env.ts.
    APP_ROUTER_FLY_APP_NAME: z.string().optional(),

    // Server secret the per-app fly-replay `state` key is derived from (see
    // services/app-hosting/app-replay-key.ts). A configured value must be >= 32
    // chars, but a blank placeholder is accepted — mirroring
    // SANDBOX_SESSION_SECRET — so an empty value makes the router refuse to
    // emit replays (fail closed) rather than failing app-wide env validation.
    APP_REPLAY_SECRET: z.string().min(32).optional().or(z.literal('')),

    // Shared secret proving a router request came from the edge proxy. Optional
    // and blank-tolerant for the same reason; the router treats an unset value
    // as "refuse everything", never as "skip the check" — the endpoint would
    // otherwise be a world-callable fly-replay emitter for the whole Fly org.
    // A CONFIGURED value must clear the same >=32 floor as APP_REPLAY_SECRET: a
    // guessable secret is not a weaker check, it is the absence of one, and this
    // is the check that stops the endpoint being world-callable. Enforced again
    // in resolveAppRouterProxySecret, which reads process.env directly.
    APP_ROUTER_PROXY_SECRET: z.string().min(32).optional().or(z.literal('')),

    // Sentry server/edge DSN. Fail-loud in production for cloud/tenant (see
    // superRefine below) — a missing DSN previously meant Sentry.init({dsn:
    // undefined}) silently no-op'd with zero alerts ever reaching a human.
    // Onprem is exempt: Sentry is a third-party SaaS integration, and onprem
    // already disables that class of integration (OAuth, external AI,
    // Calendar) per deployment-mode.ts.
    SENTRY_DSN: z.string().optional(),
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

    // App hosting serves customer-authored SERVER code on subdomains of one apex.
    // Because that apex must be on the Public Suffix List before it carries
    // untrusted origins — otherwise one published app sets a `domain=<apex>`
    // cookie every other published app then sends — the apex is not something a
    // deployment may arrive at by default. PUBLISHED_APPS_APEX_DEFAULT stays the
    // documented value and keeps resolvePublishedAppsApex from ever returning ''
    // (an empty apex would make parseAppHost claim EVERY hostname), but turning
    // hosting on requires naming the apex explicitly, so the PSL prerequisite has
    // an owner who chose it rather than inheriting it silently. See ROUTING.md.
    if (data.APP_HOSTING_ENABLED === 'true' && !data.PUBLISHED_APPS_APEX?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'PUBLISHED_APPS_APEX must be set explicitly when APP_HOSTING_ENABLED=true — published apps run customer server code, so the apex they share has to be a deliberate, PSL-registered choice rather than a default',
        path: ['PUBLISHED_APPS_APEX'],
      });
    }

    if (data.NODE_ENV === 'production' && !isOnPrem() && !data.SENTRY_DSN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SENTRY_DSN is required in production (cloud/tenant) so crashes reach Sentry — onprem deployments are exempt',
        path: ['SENTRY_DSN'],
      });
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

/**
 * Fail-loud SENTRY_DSN check for services that don't run the full
 * serverEnvSchema (realtime, processor, control-plane, admin). Mirrors the
 * schema's production/onprem-exempt SENTRY_DSN rule via process.env directly.
 * @throws Error naming the service if production, non-onprem, and SENTRY_DSN is unset.
 */
export const requireSentryDsn = (serviceName: string): void => {
  if (process.env.NODE_ENV === 'production' && !isOnPrem() && !process.env.SENTRY_DSN) {
    throw new Error(
      `SENTRY_DSN is required in production for ${serviceName} so crashes reach Sentry (onprem deployments are exempt).`
    );
  }
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
