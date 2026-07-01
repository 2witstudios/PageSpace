# PageSpace

AI-native knowledge management platform. bun workspace + Turbo monorepo.

## Monorepo Layout

```
apps/       web (Next.js 15), realtime (Socket.IO), processor (file processing),
            control-plane (billing/provisioning), admin, marketing, atlas,
            desktop (Electron), ios/android (Capacitor), e2e
packages/   db (Drizzle/Postgres), lib (auth, permissions, services, integrations)
```

## Critical Rules

- **bun only**. Never npm/pnpm. Bun workspace breaks otherwise.
- **Next.js 15 async params**: `params` in dynamic routes are Promises. Always `await context.params`. Destructuring without await = silent runtime bug.
- **Migrations**: Never edit SQL in `packages/db/drizzle/`. Run `bun run db:generate` from schema changes.
- **No `any` types**. TypeScript strict mode.
- **Message content**: Use `parts` array structure. See `packages/lib/src/types.ts`.
- **Permissions**: Use centralized functions from `packages/lib/src/permissions/`. Never roll your own.
- **UI refresh protection**: Components editing/streaming content must register with `useEditingStore` (`apps/web/src/stores/useEditingStore.ts`) to prevent SWR clobbering.

## Deployment Modes

`DEPLOYMENT_MODE` env var controls feature gating (`packages/lib/src/deployment-mode.ts`):

- `cloud` (default) — SaaS. Full features, Stripe billing.
- `tenant` — Dedicated-image cloud. Same feature set as cloud; different infra topology and billing path (control plane, not Stripe).
- `onprem` — Self-hosted. No external integrations (OAuth, Google Calendar, external AI). Password auth, local AI only.

Guard selection: use `isOnPrem()` to gate integrations. `isBillingEnabled()` gates billing (false for onprem + tenant). Never use `!isCloud()` to gate integrations — it incorrectly restricts tenant.

## Key Source Locations

| Area | Path |
|------|------|
| Page types enum | `packages/lib/src/utils/enums.ts` |
| Permissions | `packages/lib/src/permissions/` |
| Auth (tokens, sessions) | `packages/lib/src/auth/` |
| UI refresh protection | `apps/web/src/stores/useEditingStore.ts` |
| Integrations | `packages/lib/src/integrations/` |
| DB schema | `packages/db/src/schema/` |
| Services | `packages/lib/src/services/` |
| Deployment mode | `packages/lib/src/deployment-mode.ts` |
| AI provider setup | `apps/web/src/lib/ai/` |
| Real-time events | `apps/realtime/src/` |

## Commands

```bash
bun run dev          # All services (excludes control-plane)
bun run build        # All apps (Turbo)
bun run typecheck    # TypeScript across monorepo
bun run lint         # All apps
bun run test         # All tests (with DB setup)
bun run test:unit    # Unit tests only
bun run db:generate  # Generate Drizzle migrations
bun run db:migrate   # Run migrations
```
