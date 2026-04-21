export type AtlasTone =
  | 'client'
  | 'app'
  | 'service'
  | 'shared'
  | 'kernel'
  | 'data'
  | 'external';

export type EdgeKind = 'request' | 'events' | 'storage' | 'dependency' | 'external' | 'ops';

export type PositionName = 'left' | 'right' | 'top' | 'bottom';

export interface AtlasEntity {
  id: string;
  title: string;
  eyebrow: string;
  tone: AtlasTone;
  summary: string;
  boundary: string;
  owns: string[];
  dependsOn: string[];
  touchpoints: string[];
}

export interface AtlasTreeNode {
  label: string;
  note: string;
  path?: string;
  children?: AtlasTreeNode[];
}

export interface AtlasSystem extends AtlasEntity {
  group: string;
  shortLabel: string;
  tree: AtlasTreeNode[];
}

export interface GraphNodeDefinition {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  tone: AtlasTone;
  position: { x: number; y: number };
  width?: number;
  sourcePosition?: PositionName;
  targetPosition?: PositionName;
}

export interface GraphEdgeDefinition {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: EdgeKind;
}

export interface GraphZoneDefinition {
  id: string;
  title: string;
  subtitle: string;
  tone: AtlasTone;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface GraphDefinition {
  title: string;
  subtitle: string;
  defaultFocus: string;
  zones?: GraphZoneDefinition[];
  nodes: GraphNodeDefinition[];
  edges: GraphEdgeDefinition[];
}

export interface KernelSatellite {
  id: string;
  title: string;
  summary: string;
  path: string;
  slot:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'middle-left'
    | 'middle-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';
}

export interface OperationalCurrent {
  id: string;
  title: string;
  caption: string;
  tone: AtlasTone;
  steps: string[];
}

export const overviewStats = [
  { label: 'Product apps', value: '7', note: 'marketing, web, realtime, processor, desktop, iOS, android' },
  { label: 'Shared packages', value: '2', note: 'db schema + shared domain library' },
  { label: 'Runtime services', value: '4', note: 'web, realtime, processor, cron' },
  { label: 'State planes', value: '4', note: 'Postgres, Redis cache, Redis session, local volumes' },
];

export const runtimeOnlyEntities: AtlasEntity[] = [
  {
    id: 'browser-client',
    title: 'Browser Clients',
    eyebrow: 'Human edge',
    tone: 'client',
    summary: 'People either enter through marketing or directly into the authenticated workspace.',
    boundary: 'This is the browser execution surface, not a codebase root.',
    owns: ['Rendering sessions', 'Navigation state', 'Input into marketing and workspace surfaces'],
    dependsOn: ['apps/marketing for public narrative', 'apps/web for the actual product experience'],
    touchpoints: ['HTTP(S) traffic', 'SSR hydration', 'authenticated workspace navigation'],
  },
];

export const systems: AtlasSystem[] = [
  {
    id: 'marketing',
    title: 'Marketing Site',
    shortLabel: 'apps/marketing',
    eyebrow: 'Public edge app',
    tone: 'app',
    group: 'Experience Surfaces',
    summary: 'Separate Next.js marketing/docs surface for landing pages, pricing, docs, screenshots, and public contact flows.',
    boundary: 'Top-of-funnel and documentation. It should explain the product, not own the workspace kernel.',
    owns: ['Public content routes', 'Docs navigation', 'Pricing/download funnels'],
    dependsOn: ['Browser traffic', 'Public brand assets', 'Handoffs into the product app'],
    touchpoints: ['apps/marketing/src/app', 'apps/marketing/src/components', 'public docs + CTA flows'],
    tree: [
      {
        label: 'src/app',
        path: 'apps/marketing/src/app',
        note: 'Next app routes for landing, docs, blog, pricing, screenshots, contact, and downloads.',
        children: [
          { label: 'page.tsx + docs/*', note: 'Public story, docs IA, and SEO surfaces.' },
          { label: 'pricing/page.tsx + downloads/page.tsx', note: 'Commercial handoff into the product.' },
        ],
      },
      {
        label: 'src/components/sections',
        path: 'apps/marketing/src/components/sections',
        note: 'Narrative blocks for channels, documents, tasks, security, and the page tree concept.',
      },
      {
        label: 'src/components',
        path: 'apps/marketing/src/components',
        note: 'Site chrome, docs sidebar, search, contact form, screenshots, and preview shells.',
      },
    ],
  },
  {
    id: 'web',
    title: 'Web Application',
    shortLabel: 'apps/web',
    eyebrow: 'Primary product surface',
    tone: 'app',
    group: 'Experience Surfaces',
    summary: 'Main Next.js 15 workspace. It serves the UI shell, route handlers, page rendering, AI orchestration, auth, billing, and exports.',
    boundary: 'This is the orchestration brain of the product and the closest application surface to the page kernel.',
    owns: ['App Router UI shell', 'API routes', 'Page-type rendering', 'AI and billing integrations'],
    dependsOn: ['packages/lib', 'packages/db', 'realtime', 'processor', 'Postgres', 'Redis', 'external APIs'],
    touchpoints: ['apps/web/src/app', 'apps/web/src/services/api', 'apps/web/src/components/layout', 'apps/web/src/lib/ai'],
    tree: [
      {
        label: 'src/app',
        path: 'apps/web/src/app',
        note: 'Route tree for the workspace UI plus all HTTP entrypoints under api/*.',
        children: [
          { label: 'api/*', note: 'Pages, auth, AI, workflows, storage, exports, billing, integrations.' },
          { label: 'p/[pageId] + account + notifications', note: 'Primary app screens and route-level entrypoints.' },
        ],
      },
      {
        label: 'src/services/api',
        path: 'apps/web/src/services/api',
        note: 'Write orchestration, rollback, mentions, reorder, and other route-facing domain services.',
        children: [
          { label: 'page-service.ts', note: 'CRUD boundary into the page kernel.' },
          { label: 'page-mutation-service.ts', note: 'Revision, state hash, versioning, and activity write contract.' },
          { label: 'rollback-service.ts', note: 'Cross-resource undo/redo engine.' },
        ],
      },
      {
        label: 'src/components/layout',
        path: 'apps/web/src/components/layout',
        note: 'Shell, sidebars, center panel, page dispatch, and cross-page chrome.',
      },
      {
        label: 'src/lib/ai',
        path: 'apps/web/src/lib/ai',
        note: 'Provider wiring, tool registry, page-tree context, and agent orchestration.',
      },
    ],
  },
  {
    id: 'desktop-shell',
    title: 'Desktop Shell',
    shortLabel: 'apps/desktop',
    eyebrow: 'Native wrapper',
    tone: 'app',
    group: 'Experience Surfaces',
    summary: 'Electron app that wraps the workspace, adds desktop auth/session handling, MCP management, updates, tray, and native permissions.',
    boundary: 'Desktop delivery and local OS integration. It does not replace the web domain model.',
    owns: ['Electron main process', 'Desktop auth storage', 'Native menu, tray, and updater'],
    dependsOn: ['The web workspace', 'Desktop IPC/preload bridge', 'WebSocket and auth sessions'],
    touchpoints: ['apps/desktop/src/main', 'apps/desktop/src/preload', 'apps/desktop/src/shared'],
    tree: [
      {
        label: 'src/main',
        path: 'apps/desktop/src/main',
        note: 'Electron main process: app boot, deep links, windows, updater, tray, MCP manager, and auth/session plumbing.',
        children: [
          { label: 'index.ts + window.ts', note: 'Window lifecycle and application startup.' },
          { label: 'auth-session.ts + auth-storage.ts', note: 'Desktop token/session storage boundary.' },
          { label: 'mcp-manager.ts + ipc-handlers.ts', note: 'Desktop-native tool and bridge integration.' },
        ],
      },
      {
        label: 'src/preload',
        path: 'apps/desktop/src/preload',
        note: 'Secure bridge from rendered web content into desktop-native capabilities.',
      },
      {
        label: 'electron.vite.config.ts',
        path: 'apps/desktop/electron.vite.config.ts',
        note: 'Separate desktop build pipeline from the main web app.',
      },
    ],
  },
  {
    id: 'mobile-shells',
    title: 'Mobile Shells',
    shortLabel: 'apps/ios + apps/android',
    eyebrow: 'Native wrappers',
    tone: 'app',
    group: 'Experience Surfaces',
    summary: 'Capacitor wrappers that package the web workspace for iOS and Android with platform plugins for keyboard, push, browser, and status bar.',
    boundary: 'Delivery shells for the web app. They should stay thin and avoid forking core product behavior.',
    owns: ['Capacitor platform configs', 'Native project scaffolds', 'Platform plugin wiring'],
    dependsOn: ['The built web app', 'Capacitor sync', 'Platform-specific native tooling'],
    touchpoints: ['apps/ios/capacitor.config.ts', 'apps/android/capacitor.config.ts', 'apps/*/public/index.html'],
    tree: [
      {
        label: 'apps/ios',
        path: 'apps/ios',
        note: 'Capacitor iOS wrapper with sync/build scripts and native Xcode project.',
      },
      {
        label: 'apps/android',
        path: 'apps/android',
        note: 'Capacitor Android wrapper with sync/run scripts and native Gradle project.',
      },
      {
        label: 'workspace dependency on web',
        note: 'Both wrappers depend on the web workspace build instead of reimplementing product logic.',
      },
    ],
  },
  {
    id: 'realtime',
    title: 'Realtime Service',
    shortLabel: 'apps/realtime',
    eyebrow: 'Dedicated event plane',
    tone: 'service',
    group: 'Application Services',
    summary: 'Socket.IO service for presence, rooms, page updates, auth-checked event fanout, and live collaboration signals.',
    boundary: 'Broadcast and presence, not business truth. It should mirror state after web/db decisions, not invent state.',
    owns: ['Socket rooms', 'Presence tracking', 'Per-event auth', 'Broadcast signature checks'],
    dependsOn: ['packages/lib permissions + auth', 'packages/db queries', 'Redis', 'Postgres'],
    touchpoints: ['apps/realtime/src/index.ts', 'apps/realtime/src/per-event-auth.ts', 'apps/realtime/src/presence-tracker.ts'],
    tree: [
      {
        label: 'src/index.ts',
        path: 'apps/realtime/src/index.ts',
        note: 'Bootstraps Socket.IO, room joins, message fanout, and page/drive presence handling.',
      },
      {
        label: 'src/per-event-auth.ts',
        path: 'apps/realtime/src/per-event-auth.ts',
        note: 'Zero-trust permission rechecks for sensitive events.',
      },
      {
        label: 'src/presence-tracker.ts + socket-registry.ts',
        path: 'apps/realtime/src',
        note: 'Presence model and socket registry bookkeeping.',
      },
    ],
  },
  {
    id: 'processor',
    title: 'Processor Service',
    shortLabel: 'apps/processor',
    eyebrow: 'File pipeline',
    tone: 'service',
    group: 'Application Services',
    summary: 'Standalone Express service for upload, optimization, OCR, text extraction, file serving, and page/file resource binding.',
    boundary: 'Heavy file work and content transformation. It should not own workspace navigation or page truth.',
    owns: ['Upload/ingest endpoints', 'OCR/text workers', 'File/cache volumes', 'Resource-bound auth'],
    dependsOn: ['packages/db', 'packages/lib auth/permissions/security', 'Postgres', 'Redis session plane', 'local volumes'],
    touchpoints: ['apps/processor/src/server.ts', 'apps/processor/src/api', 'apps/processor/src/services', 'apps/processor/src/workers'],
    tree: [
      {
        label: 'src/server.ts',
        path: 'apps/processor/src/server.ts',
        note: 'Bootstraps the processor API, queue endpoints, auth middleware, and cache/file services.',
      },
      {
        label: 'src/api',
        path: 'apps/processor/src/api',
        note: 'Upload, ingest, optimize, serve, avatar, and delete-file routes.',
      },
      {
        label: 'src/middleware',
        path: 'apps/processor/src/middleware',
        note: 'Service auth, rate limiting, and resource/page binding.',
      },
      {
        label: 'src/workers',
        path: 'apps/processor/src/workers',
        note: 'Image processing, OCR, extraction, and queue management.',
      },
    ],
  },
  {
    id: 'cron',
    title: 'Cron Runner',
    shortLabel: 'docker/cron',
    eyebrow: 'Scheduled automation plane',
    tone: 'service',
    group: 'Application Services',
    summary: 'Containerized scheduler that calls authenticated web cron routes for recurring tasks like pulse and memory jobs.',
    boundary: 'Time-based trigger surface only. It should invoke web workflows, not duplicate domain behavior.',
    owns: ['Crontab schedule', 'Cron container entrypoint', 'Signed HTTP invocation of web routes'],
    dependsOn: ['docker/cron', 'web cron routes', 'CRON_SECRET'],
    touchpoints: ['docker/cron/Dockerfile', 'docker/cron/crontab', 'apps/web/src/app/api/*/cron/route.ts'],
    tree: [
      {
        label: 'docker/cron',
        path: 'docker/cron',
        note: 'Cron image, crontab, and boot script that run inside the docker network.',
      },
      {
        label: 'api/pulse/cron + api/memory/cron',
        path: 'apps/web/src/app/api',
        note: 'Web-side scheduled endpoints reached by cron.',
      },
    ],
  },
  {
    id: 'page-kernel',
    title: 'Page Kernel',
    shortLabel: 'core page primitive',
    eyebrow: 'Sacred boundary',
    tone: 'kernel',
    group: 'Shared Code + Kernel',
    summary: 'Composite kernel around the `pages` table, tree shape, page type registry, mutation contract, permissions, audit, and versions.',
    boundary: 'Anything that changes tree shape, page identity, or mutation semantics belongs here or must pass through here.',
    owns: ['Page identity + hierarchy', 'Page-type registry', 'Mutation authority', 'Audit/version chain'],
    dependsOn: ['packages/db schema roots', 'packages/lib content + monitoring', 'web service layer orchestration'],
    touchpoints: ['packages/db/src/schema/core.ts', 'packages/lib/src/content/page-types.config.ts', 'apps/web/src/services/api/page-mutation-service.ts'],
    tree: [
      {
        label: 'packages/db/src/schema/core.ts',
        path: 'packages/db/src/schema/core.ts',
        note: 'Canonical `pages` and `drives` schema with parentId, type, revision, state hash, AI config, and file metadata.',
      },
      {
        label: 'packages/lib/src/content/page-types.config.ts',
        path: 'packages/lib/src/content/page-types.config.ts',
        note: 'Page-type registry and renderer contract.',
      },
      {
        label: 'packages/lib/src/pages/circular-reference-guard.ts',
        path: 'packages/lib/src/pages/circular-reference-guard.ts',
        note: 'Tree invariant enforcement for move operations.',
      },
      {
        label: 'apps/web/src/services/api/page-service.ts + page-mutation-service.ts',
        path: 'apps/web/src/services/api',
        note: 'Public CRUD seam and mutation pipeline for revision, state hash, versioning, mentions, and activity.',
      },
      {
        label: 'packages/lib/src/monitoring/activity-logger.ts + packages/db/src/schema/versioning.ts',
        path: 'packages/lib/src/monitoring',
        note: 'Audit trail and persisted version chain around each mutation.',
      },
    ],
  },
  {
    id: 'packages-lib',
    title: 'Shared Domain Library',
    shortLabel: 'packages/lib',
    eyebrow: 'Cross-app logic',
    tone: 'shared',
    group: 'Shared Code + Kernel',
    summary: 'Shared services for permissions, monitoring, auth, content rules, security, caching, notifications, storage limits, and AI support code.',
    boundary: 'Domain logic shared across apps. Good home for invariants that must be reused consistently.',
    owns: ['Permissions API', 'Monitoring and audit helpers', 'Shared Redis/cache helpers', 'Content and page-type helpers'],
    dependsOn: ['packages/db for schema-backed queries', 'Redis when available', 'env-configured external services'],
    touchpoints: ['packages/lib/src/permissions', 'packages/lib/src/monitoring', 'packages/lib/src/services', 'packages/lib/src/content'],
    tree: [
      {
        label: 'src/permissions',
        path: 'packages/lib/src/permissions',
        note: 'Access checks, enforced auth context, rollback permission rules, and mutation helpers.',
      },
      {
        label: 'src/monitoring',
        path: 'packages/lib/src/monitoring',
        note: 'Activity logging, hash verification, AI context tracking, and change-group helpers.',
      },
      {
        label: 'src/services',
        path: 'packages/lib/src/services',
        note: 'Redis/cache adapters, version storage, member services, rate limits, and storage utilities.',
      },
      {
        label: 'src/content',
        path: 'packages/lib/src/content',
        note: 'Page types, content format resolution, diffs, exports, and content semantics.',
      },
    ],
  },
  {
    id: 'packages-db',
    title: 'Database Package',
    shortLabel: 'packages/db',
    eyebrow: 'Schema source of truth',
    tone: 'shared',
    group: 'Shared Code + Kernel',
    summary: 'Central Drizzle package containing schema, relations, migrations, and the query client consumed across services.',
    boundary: 'Single schema source of truth. All runtime services should agree on these tables and relations.',
    owns: ['Schema modules', 'Drizzle client', 'Migration output'],
    dependsOn: ['Postgres', 'Drizzle ORM'],
    touchpoints: ['packages/db/src/schema', 'packages/db/drizzle', 'packages/db/src/index.ts'],
    tree: [
      {
        label: 'src/schema',
        path: 'packages/db/src/schema',
        note: 'Schema modules for core pages, members, monitoring, versioning, storage, auth, chat, tasks, AI, and subscriptions.',
        children: [
          { label: 'core.ts + members.ts', note: 'Pages, drives, memberships, and ACL-adjacent structure.' },
          { label: 'monitoring.ts + versioning.ts', note: 'Audit, rollback, and page version persistence.' },
          { label: 'storage.ts + tasks.ts + chat.ts', note: 'File links, tasks, and messaging tables.' },
        ],
      },
      {
        label: 'drizzle',
        path: 'packages/db/drizzle',
        note: 'Generated migration history applied to Postgres.',
      },
    ],
  },
  {
    id: 'postgres',
    title: 'Postgres',
    shortLabel: 'postgres service',
    eyebrow: 'System of record',
    tone: 'data',
    group: 'State + Storage',
    summary: 'Primary durable store for pages, users, messages, tasks, permissions, subscriptions, audit logs, and versions.',
    boundary: 'Durable truth. If it mutates business state, it should end up here or be derivable from here.',
    owns: ['Relational source of truth', 'Transactions', 'Schema-backed durability'],
    dependsOn: ['packages/db schema and migrations', 'Consumers in web, realtime, and processor'],
    touchpoints: ['docker-compose.yml: postgres', 'packages/db/src/schema', 'packages/db/drizzle'],
    tree: [
      {
        label: 'docker-compose postgres service',
        path: 'docker-compose.yml',
        note: 'Local deployment definition for the database container and volume.',
      },
      {
        label: 'packages/db/src/schema',
        path: 'packages/db/src/schema',
        note: 'The code contract that shapes nearly all durable state.',
      },
      {
        label: 'packages/db/drizzle',
        path: 'packages/db/drizzle',
        note: 'Migration history applied on startup by the migrate service.',
      },
    ],
  },
  {
    id: 'redis-cache',
    title: 'Redis Cache Plane',
    shortLabel: 'redis service',
    eyebrow: 'L2 cache + fanout support',
    tone: 'data',
    group: 'State + Storage',
    summary: 'Shared Redis used for cache-backed read acceleration and realtime scale-out support.',
    boundary: 'Acceleration and coordination only. Loss should degrade performance, not destroy workspace truth.',
    owns: ['Cross-process cache store', 'Shared Redis client', 'Ephemeral coordination layer'],
    dependsOn: ['REDIS_URL', 'packages/lib shared-redis adapter', 'realtime + web consumers'],
    touchpoints: ['docker-compose.yml: redis', 'packages/lib/src/services/shared-redis.ts'],
    tree: [
      {
        label: 'shared-redis.ts',
        path: 'packages/lib/src/services/shared-redis.ts',
        note: 'Central Redis connection and fallback-to-memory behavior.',
      },
      {
        label: 'docker-compose redis service',
        path: 'docker-compose.yml',
        note: 'Dedicated Redis container with LRU memory policy for cache-style usage.',
      },
    ],
  },
  {
    id: 'redis-sessions',
    title: 'Redis Session Plane',
    shortLabel: 'redis-sessions service',
    eyebrow: 'Session + rate limit state',
    tone: 'data',
    group: 'State + Storage',
    summary: 'Separate Redis instance used for auth/session data and rate limiting across web, realtime, and processor.',
    boundary: 'Ephemeral security and throttling state, deliberately separated from the cache plane.',
    owns: ['Session store', 'Rate limit buckets', 'Security-adjacent ephemeral state'],
    dependsOn: ['REDIS_SESSION_URL', 'REDIS_RATE_LIMIT_URL', 'auth and rate limit consumers'],
    touchpoints: ['docker-compose.yml: redis-sessions', 'web env vars', 'processor env vars', 'realtime env vars'],
    tree: [
      {
        label: 'docker-compose redis-sessions service',
        path: 'docker-compose.yml',
        note: 'Separate Redis process with smaller memory budget for session/rate-limit concerns.',
      },
      {
        label: 'session + rate limit env wiring',
        note: 'Used by web, processor, and realtime via dedicated connection strings.',
      },
      {
        label: 'packages/lib cache helpers',
        path: 'packages/lib/src/services',
        note: 'Rate limit and permission/session-adjacent helpers sit in the shared library.',
      },
    ],
  },
  {
    id: 'file-storage',
    title: 'Local File Volumes',
    shortLabel: 'file_storage + cache_storage',
    eyebrow: 'Blob and derived asset plane',
    tone: 'data',
    group: 'State + Storage',
    summary: 'Local mounted volumes for original files and processor cache artifacts, with metadata indexed back into Postgres.',
    boundary: 'Blob persistence and transformation cache, not relational truth.',
    owns: ['Original files', 'Derived cache artifacts', 'Shared mounted storage paths'],
    dependsOn: ['processor workers', 'web file viewers/download flows', 'storage.ts metadata links'],
    touchpoints: ['docker-compose.yml volumes', 'packages/db/src/schema/storage.ts', 'apps/processor/src/cache/content-store.ts'],
    tree: [
      {
        label: 'docker-compose volumes',
        path: 'docker-compose.yml',
        note: 'Mounted `file_storage` and `cache_storage` volumes shared across services.',
      },
      {
        label: 'storage.ts',
        path: 'packages/db/src/schema/storage.ts',
        note: 'Metadata and file-to-page link tables that index the blob layer.',
      },
      {
        label: 'processor content-store',
        path: 'apps/processor/src/cache/content-store.ts',
        note: 'Disk-backed cache abstraction used by the processor service.',
      },
    ],
  },
  {
    id: 'ai-providers',
    title: 'AI Provider Mesh',
    shortLabel: 'Ollama + cloud providers',
    eyebrow: 'External inference plane',
    tone: 'external',
    group: 'External Contracts',
    summary: 'Local Ollama plus cloud providers via OpenRouter, Google, Anthropic, and OpenAI-compatible adapters.',
    boundary: 'Inference and tool completion only. Provider choice should not leak into page kernel semantics.',
    owns: ['Streaming completions', 'Model selection', 'External inference contracts'],
    dependsOn: ['web AI routes', 'provider config', 'usage/billing enforcement'],
    touchpoints: ['apps/web/src/app/api/ai', 'apps/web/src/lib/ai', 'provider env vars'],
    tree: [
      {
        label: 'apps/web/src/app/api/ai',
        path: 'apps/web/src/app/api/ai',
        note: 'Chat, global assistant, provider discovery, settings, and usage endpoints.',
      },
      {
        label: 'apps/web/src/lib/ai',
        path: 'apps/web/src/lib/ai',
        note: 'Provider adapters, tools, contexts, and agent orchestration.',
      },
      {
        label: 'env-configured provider credentials',
        note: 'Ollama base URL plus cloud provider keys live outside the code graph.',
      },
    ],
  },
  {
    id: 'stripe',
    title: 'Stripe',
    shortLabel: 'billing contract',
    eyebrow: 'External commerce plane',
    tone: 'external',
    group: 'External Contracts',
    summary: 'Subscription creation, portal, invoices, payment methods, promos, and subscription status flows.',
    boundary: 'Billing and entitlements. It should gate product capabilities, not own workspace data structures.',
    owns: ['Subscription lifecycle', 'Payment methods', 'Entitlement signal into the product'],
    dependsOn: ['web billing routes', 'subscription status consumers'],
    touchpoints: ['apps/web/src/app/api/stripe', 'apps/web/src/app/api/subscriptions', 'apps/web/src/lib/stripe*'],
    tree: [
      {
        label: 'api/stripe',
        path: 'apps/web/src/app/api/stripe',
        note: 'Checkout, customer, portal, invoices, promo, payment method, and webhook routes.',
      },
      {
        label: 'api/subscriptions',
        path: 'apps/web/src/app/api/subscriptions',
        note: 'Product-side subscription status and usage surfaces.',
      },
    ],
  },
  {
    id: 'google-services',
    title: 'Google Services',
    shortLabel: 'OAuth + Calendar',
    eyebrow: 'External integration plane',
    tone: 'external',
    group: 'External Contracts',
    summary: 'OAuth flows, Calendar sync, calendar webhooks, and Google account integration endpoints.',
    boundary: 'External identity and calendar sync. It should integrate with drives and workflows without redefining workspace truth.',
    owns: ['Google OAuth handshake', 'Calendar sync/status/callbacks', 'Calendar connection lifecycle'],
    dependsOn: ['web integration routes', 'stored connection metadata', 'user auth context'],
    touchpoints: ['apps/web/src/app/api/auth/google', 'apps/web/src/app/api/integrations/google-calendar', 'apps/web/src/app/api/connections'],
    tree: [
      {
        label: 'auth/google + desktop exchange',
        path: 'apps/web/src/app/api/auth',
        note: 'OAuth callback and related auth handoff routes.',
      },
      {
        label: 'integrations/google-calendar',
        path: 'apps/web/src/app/api/integrations/google-calendar',
        note: 'Connect, disconnect, sync, status, webhook, calendars, and settings routes.',
      },
      {
        label: 'connections',
        path: 'apps/web/src/app/api/connections',
        note: 'Generic connection registry used by integrations.',
      },
    ],
  },
];

export const runtimeGraph: GraphDefinition = {
  title: 'Runtime Topology',
  subtitle: 'What actually runs when PageSpace is alive locally: entry surfaces, service plane, state plane, and external contracts.',
  defaultFocus: 'web',
  zones: [
    {
      id: 'runtime-clients',
      title: 'Client Edge',
      subtitle: 'Humans and native wrappers that enter the system.',
      tone: 'client',
      position: { x: 0, y: 210 },
      width: 280,
      height: 620,
    },
    {
      id: 'runtime-surfaces',
      title: 'Entry Surfaces',
      subtitle: 'Public narrative and the authenticated web workspace.',
      tone: 'app',
      position: { x: 300, y: 40 },
      width: 300,
      height: 490,
    },
    {
      id: 'runtime-services',
      title: 'Service Plane',
      subtitle: 'Realtime fanout, file work, and scheduled triggers.',
      tone: 'service',
      position: { x: 620, y: 70 },
      width: 300,
      height: 690,
    },
    {
      id: 'runtime-state',
      title: 'State Plane',
      subtitle: 'Authoritative records plus cache/session support planes.',
      tone: 'data',
      position: { x: 930, y: 40 },
      width: 290,
      height: 860,
    },
    {
      id: 'runtime-external',
      title: 'External Contracts',
      subtitle: 'Providers PageSpace depends on but does not own.',
      tone: 'external',
      position: { x: 1230, y: 90 },
      width: 290,
      height: 640,
    },
  ],
  nodes: [
    {
      id: 'browser-client',
      title: 'Browser Clients',
      subtitle: 'Public + workspace traffic',
      description: 'Humans entering through marketing or the product',
      tone: 'client',
      position: { x: 30, y: 260 },
      width: 230,
    },
    {
      id: 'desktop-shell',
      title: 'Desktop Shell',
      subtitle: 'Electron wrapper',
      description: 'Native app that hosts the web workspace',
      tone: 'app',
      position: { x: 30, y: 440 },
      width: 230,
    },
    {
      id: 'mobile-shells',
      title: 'Mobile Shells',
      subtitle: 'Capacitor iOS + Android',
      description: 'Thin native wrappers over the web build',
      tone: 'app',
      position: { x: 30, y: 620 },
      width: 230,
    },
    {
      id: 'marketing',
      title: 'Marketing',
      subtitle: 'Public Next.js surface',
      description: 'Landing, docs, blog, pricing, downloads',
      tone: 'app',
      position: { x: 330, y: 90 },
      width: 230,
    },
    {
      id: 'web',
      title: 'Web',
      subtitle: 'Next.js 15 workspace',
      description: 'UI, API routes, auth, AI, billing, exports',
      tone: 'app',
      position: { x: 330, y: 300 },
      width: 250,
    },
    {
      id: 'realtime',
      title: 'Realtime',
      subtitle: 'Socket.IO service',
      description: 'Presence, rooms, live updates, per-event auth',
      tone: 'service',
      position: { x: 650, y: 120 },
      width: 240,
    },
    {
      id: 'processor',
      title: 'Processor',
      subtitle: 'Express file pipeline',
      description: 'Upload, OCR, optimize, ingest, serve',
      tone: 'service',
      position: { x: 650, y: 340 },
      width: 240,
    },
    {
      id: 'cron',
      title: 'Cron',
      subtitle: 'Scheduled route trigger',
      description: 'Runs web cron routes inside docker network',
      tone: 'service',
      position: { x: 650, y: 600 },
      width: 240,
    },
    {
      id: 'postgres',
      title: 'Postgres',
      subtitle: 'System of record',
      description: 'Pages, users, tasks, messages, versions, audit',
      tone: 'data',
      position: { x: 960, y: 90 },
      width: 230,
    },
    {
      id: 'redis-cache',
      title: 'Redis Cache',
      subtitle: 'L2 cache + coordination',
      description: 'Shared Redis for cache-backed acceleration',
      tone: 'data',
      position: { x: 960, y: 280 },
      width: 230,
    },
    {
      id: 'redis-sessions',
      title: 'Redis Session',
      subtitle: 'Auth + rate limit plane',
      description: 'Separate Redis for session and throttling state',
      tone: 'data',
      position: { x: 960, y: 470 },
      width: 230,
    },
    {
      id: 'file-storage',
      title: 'Local Volumes',
      subtitle: 'Files + processor cache',
      description: 'Mounted blob and cache storage',
      tone: 'data',
      position: { x: 960, y: 660 },
      width: 230,
    },
    {
      id: 'ai-providers',
      title: 'AI Providers',
      subtitle: 'Ollama + cloud mesh',
      description: 'Inference backends for chat and agents',
      tone: 'external',
      position: { x: 1260, y: 140 },
      width: 230,
    },
    {
      id: 'stripe',
      title: 'Stripe',
      subtitle: 'Billing contract',
      description: 'Subscriptions, portal, invoices, promos',
      tone: 'external',
      position: { x: 1260, y: 360 },
      width: 230,
    },
    {
      id: 'google-services',
      title: 'Google Services',
      subtitle: 'OAuth + Calendar',
      description: 'Identity and calendar sync surface',
      tone: 'external',
      position: { x: 1260, y: 580 },
      width: 230,
    },
  ],
  edges: [
    { id: 'browser-marketing', source: 'browser-client', target: 'marketing', label: 'public browse', kind: 'request' },
    { id: 'browser-web', source: 'browser-client', target: 'web', label: 'workspace request', kind: 'request' },
    { id: 'desktop-web', source: 'desktop-shell', target: 'web', label: 'bundled workspace', kind: 'request' },
    { id: 'mobile-web', source: 'mobile-shells', target: 'web', label: 'Capacitor shell', kind: 'request' },
    { id: 'marketing-web', source: 'marketing', target: 'web', label: 'auth + download handoff', kind: 'request' },
    { id: 'web-realtime', source: 'web', target: 'realtime', label: 'socket tokens + broadcasts', kind: 'events' },
    { id: 'web-processor', source: 'web', target: 'processor', label: 'upload / OCR / convert', kind: 'storage' },
    { id: 'web-postgres', source: 'web', target: 'postgres', label: 'Drizzle reads + writes', kind: 'storage' },
    { id: 'web-redis-cache', source: 'web', target: 'redis-cache', label: 'cache + coordination', kind: 'storage' },
    { id: 'web-redis-sessions', source: 'web', target: 'redis-sessions', label: 'sessions + rate limits', kind: 'storage' },
    { id: 'web-files', source: 'web', target: 'file-storage', label: 'file viewers + metadata', kind: 'storage' },
    { id: 'web-ai', source: 'web', target: 'ai-providers', label: 'stream + tools', kind: 'external' },
    { id: 'web-stripe', source: 'web', target: 'stripe', label: 'billing lifecycle', kind: 'external' },
    { id: 'web-google', source: 'web', target: 'google-services', label: 'OAuth + calendar', kind: 'external' },
    { id: 'realtime-postgres', source: 'realtime', target: 'postgres', label: 'room auth + reads', kind: 'storage' },
    { id: 'realtime-redis-cache', source: 'realtime', target: 'redis-cache', label: 'presence + scale', kind: 'events' },
    { id: 'realtime-redis-sessions', source: 'realtime', target: 'redis-sessions', label: 'session validation', kind: 'storage' },
    { id: 'processor-postgres', source: 'processor', target: 'postgres', label: 'file/page metadata', kind: 'storage' },
    { id: 'processor-redis-sessions', source: 'processor', target: 'redis-sessions', label: 'service auth + rate limit', kind: 'storage' },
    { id: 'processor-files', source: 'processor', target: 'file-storage', label: 'blob + cache IO', kind: 'storage' },
    { id: 'cron-web', source: 'cron', target: 'web', label: 'signed cron routes', kind: 'ops' },
  ],
};

export const codebaseGraph: GraphDefinition = {
  title: 'Codebase Strata',
  subtitle: 'How the repo is partitioned across apps, shared packages, and the sacred page kernel.',
  defaultFocus: 'page-kernel',
  zones: [
    {
      id: 'codebase-delivery',
      title: 'Delivery Shells',
      subtitle: 'Public site and native wrappers that package the workspace.',
      tone: 'app',
      position: { x: 10, y: 50 },
      width: 290,
      height: 690,
    },
    {
      id: 'codebase-apps',
      title: 'Product Apps',
      subtitle: 'The main app and supporting runtime services.',
      tone: 'service',
      position: { x: 330, y: 130 },
      width: 310,
      height: 610,
    },
    {
      id: 'codebase-kernel',
      title: 'Sacred Boundary',
      subtitle: 'The page primitive and mutation contract everything bends around.',
      tone: 'kernel',
      position: { x: 680, y: 190 },
      width: 300,
      height: 350,
    },
    {
      id: 'codebase-lib',
      title: 'Shared Services',
      subtitle: 'Cross-cutting domain logic consumed by the apps and kernel.',
      tone: 'shared',
      position: { x: 1010, y: 90 },
      width: 300,
      height: 250,
    },
    {
      id: 'codebase-db',
      title: 'Schema Contract',
      subtitle: 'Database schema, migrations, and the client every service shares.',
      tone: 'shared',
      position: { x: 1010, y: 380 },
      width: 300,
      height: 250,
    },
  ],
  nodes: [
    {
      id: 'marketing',
      title: 'apps/marketing',
      subtitle: 'Public site',
      description: 'Docs, blog, pricing, screenshots, downloads',
      tone: 'app',
      position: { x: 40, y: 90 },
      width: 240,
    },
    {
      id: 'desktop-shell',
      title: 'apps/desktop',
      subtitle: 'Electron shell',
      description: 'Native desktop container for the workspace',
      tone: 'app',
      position: { x: 40, y: 300 },
      width: 240,
    },
    {
      id: 'mobile-shells',
      title: 'apps/ios + apps/android',
      subtitle: 'Capacitor wrappers',
      description: 'Thin native wrappers over the web build',
      tone: 'app',
      position: { x: 40, y: 540 },
      width: 240,
    },
    {
      id: 'web',
      title: 'apps/web',
      subtitle: 'Next workspace',
      description: 'The main application shell and API layer',
      tone: 'app',
      position: { x: 360, y: 170 },
      width: 250,
    },
    {
      id: 'realtime',
      title: 'apps/realtime',
      subtitle: 'Socket service',
      description: 'Realtime plane that mirrors state changes',
      tone: 'service',
      position: { x: 360, y: 380 },
      width: 250,
    },
    {
      id: 'processor',
      title: 'apps/processor',
      subtitle: 'File service',
      description: 'Asset ingest and transformation pipeline',
      tone: 'service',
      position: { x: 360, y: 600 },
      width: 250,
    },
    {
      id: 'page-kernel',
      title: 'Page Kernel',
      subtitle: 'Composite sacred boundary',
      description: 'Page tree, types, mutation contract, audit chain',
      tone: 'kernel',
      position: { x: 700, y: 220 },
      width: 260,
    },
    {
      id: 'packages-lib',
      title: 'packages/lib',
      subtitle: 'Shared domain services',
      description: 'Permissions, monitoring, content, auth, caches',
      tone: 'shared',
      position: { x: 1040, y: 140 },
      width: 240,
    },
    {
      id: 'packages-db',
      title: 'packages/db',
      subtitle: 'Schema + Drizzle client',
      description: 'Database contract and migrations',
      tone: 'shared',
      position: { x: 1040, y: 420 },
      width: 240,
    },
  ],
  edges: [
    { id: 'desktop-web-code', source: 'desktop-shell', target: 'web', label: 'hosts workspace build', kind: 'dependency' },
    { id: 'mobile-web-code', source: 'mobile-shells', target: 'web', label: 'wraps web bundle', kind: 'dependency' },
    { id: 'web-kernel-code', source: 'web', target: 'page-kernel', label: 'routes + writes through kernel', kind: 'dependency' },
    { id: 'web-lib-code', source: 'web', target: 'packages-lib', label: 'imports domain services', kind: 'dependency' },
    { id: 'web-db-code', source: 'web', target: 'packages-db', label: 'imports schema + client', kind: 'dependency' },
    { id: 'realtime-lib-code', source: 'realtime', target: 'packages-lib', label: 'auth + permissions + logging', kind: 'dependency' },
    { id: 'realtime-db-code', source: 'realtime', target: 'packages-db', label: 'socket token + room queries', kind: 'dependency' },
    { id: 'processor-lib-code', source: 'processor', target: 'packages-lib', label: 'auth + security + permissions', kind: 'dependency' },
    { id: 'processor-db-code', source: 'processor', target: 'packages-db', label: 'files + pages + users', kind: 'dependency' },
    { id: 'kernel-lib-code', source: 'page-kernel', target: 'packages-lib', label: 'content + monitoring + services', kind: 'dependency' },
    { id: 'kernel-db-code', source: 'page-kernel', target: 'packages-db', label: 'core schema + versions + monitoring', kind: 'dependency' },
    { id: 'lib-db-code', source: 'packages-lib', target: 'packages-db', label: 'schema-backed shared logic', kind: 'dependency' },
  ],
};

export const kernelCore: AtlasEntity = {
  id: 'page-kernel',
  title: 'Page Primitive Kernel',
  eyebrow: 'Composability center',
  tone: 'kernel',
  summary: 'The page file structure and tree model are the center of gravity. Anything that changes tree shape, page identity, or mutation semantics pulls against the entire system.',
  boundary: 'This is the place where page identity, parent/drive relationships, versioning, permissions, and audit semantics meet.',
  owns: ['Page identity', 'Tree structure', 'Mutation authority', 'Version + audit chain'],
  dependsOn: ['packages/db core schema', 'packages/lib content + monitoring', 'web write services'],
  touchpoints: ['core.ts', 'page-types.config.ts', 'page-service.ts', 'page-mutation-service.ts'],
};

export const kernelSatellites: KernelSatellite[] = [
  {
    id: 'kernel-model',
    title: 'Page model + tree',
    summary: 'The actual shape of pages, drives, parentId, type, revision, and state hash.',
    path: 'packages/db/src/schema/core.ts',
    slot: 'top-center',
  },
  {
    id: 'kernel-types',
    title: 'Page-type registry',
    summary: 'Single source of truth for allowed page types and renderer identities.',
    path: 'packages/lib/src/content/page-types.config.ts',
    slot: 'middle-right',
  },
  {
    id: 'kernel-writes',
    title: 'Mutation pipeline',
    summary: 'Revision, state hash, mentions, versions, and activity are written together.',
    path: 'apps/web/src/services/api/page-mutation-service.ts',
    slot: 'bottom-right',
  },
  {
    id: 'kernel-perms',
    title: 'Permissions',
    summary: 'Drive and page access checks that guard the kernel boundary.',
    path: 'packages/lib/src/permissions/permissions.ts',
    slot: 'bottom-center',
  },
  {
    id: 'kernel-audit',
    title: 'Audit + versions',
    summary: 'Activity logs and version records preserve reconstructable history.',
    path: 'packages/lib/src/monitoring/activity-logger.ts',
    slot: 'bottom-left',
  },
  {
    id: 'kernel-rollback',
    title: 'Rollback',
    summary: 'Undo/redo lives at the edge of the kernel because it replays high-value mutations.',
    path: 'apps/web/src/services/api/rollback-service.ts',
    slot: 'middle-left',
  },
  {
    id: 'kernel-files',
    title: 'Files + page links',
    summary: 'Files are separate blobs, but file pages and file links still pin back into the page graph.',
    path: 'packages/db/src/schema/storage.ts',
    slot: 'top-left',
  },
  {
    id: 'kernel-tasks-ai',
    title: 'Tasks + AI writers',
    summary: 'These are the most dangerous consumers because they create or mutate page-backed artifacts.',
    path: 'apps/web/src/lib/ai/tools/page-write-tools.ts',
    slot: 'top-right',
  },
];

export const operationalCurrents: OperationalCurrent[] = [
  {
    id: 'current-request',
    title: 'Request current',
    caption: 'Most user work enters here: shell to service to truth.',
    tone: 'app',
    steps: ['Browser / Desktop / Mobile', 'apps/web', 'packages/lib', 'packages/db', 'Postgres'],
  },
  {
    id: 'current-realtime',
    title: 'Event current',
    caption: 'Live collaboration is a secondary plane that mirrors truth after auth and persistence.',
    tone: 'service',
    steps: ['apps/web', 'auth / socket tokens', 'apps/realtime', 'Redis cache', 'connected clients'],
  },
  {
    id: 'current-files',
    title: 'Asset current',
    caption: 'Files take a heavier path because blob IO and transformation are peeled out of the web app.',
    tone: 'data',
    steps: ['client upload', 'apps/web', 'apps/processor', 'local volumes', 'file pages + viewers'],
  },
  {
    id: 'current-funnel',
    title: 'Public funnel',
    caption: 'The public story and docs remain adjacent to the workspace instead of merged into it.',
    tone: 'external',
    steps: ['browser', 'apps/marketing', 'pricing / docs / downloads', 'apps/web'],
  },
];
