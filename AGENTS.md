# Repository Guidelines

## Project Structure & Module Organization
- Monorepo managed by pnpm workspaces + Turbo.
- Apps: `apps/web` (Next.js 15), `apps/realtime` (Socket.IO), `apps/processor` (Express file/ocr pipeline).
- Packages: `packages/db` (Drizzle ORM + migrations), `packages/lib` (shared TS utilities & types).
- Support: `docs/` (design notes), `types/` (global types), `scripts/` (helpers). DB schema entry: `packages/db/src/schema.ts`; migrations emit to `packages/db/drizzle/`.

## Build, Test, and Development Commands
- Install deps: `pnpm install`
- Environment: `cp .env.example .env` (and `apps/web/.env.example → apps/web/.env` if needed)
- Database (local): `pnpm dev:db` (starts Postgres + runs migrations) or `docker compose up -d`
- Develop all apps: `pnpm dev` (runs Turbo dev across packages)
- Focus a single app: `pnpm --filter web dev` | `pnpm --filter realtime dev` | `pnpm --filter @pagespace/processor dev`
- Build: `pnpm build`  • Typecheck: `pnpm typecheck`  • Lint: `pnpm lint`
- DB tasks: `pnpm db:generate` → create migrations, `pnpm db:migrate` → apply, `pnpm --filter @pagespace/db db:studio` → browse schema

## Coding Style & Naming Conventions
- TypeScript strict mode; ESM modules.
- Filenames: kebab-case (`image-processor.ts`); React components: PascalCase; variables/functions: camelCase; constants: UPPER_SNAKE_CASE; types/enums: PascalCase.
- Format with Prettier; lint with Next/ESLint (`apps/web/eslint.config.mjs`). Keep diffs minimal and focused.

## Testing Guidelines
- No global test runner is enforced yet. When adding tests:
  - Prefer unit tests for `packages/lib`/`apps/processor` (`*.test.ts` next to source or in `__tests__/`).
  - Add a `test` script in the target package and run with `pnpm --filter <pkg> test`.
  - Use `pnpm typecheck` and `pnpm lint` as gates before PRs.

## Commit & Pull Request Guidelines
- Commits: short, imperative subject (≤72 chars), optional scope like `[web]`, `[processor]` (history shows concise subjects).
- PRs: clear description, linked issues, screenshots for UI, note DB migrations and any `.env` or config changes. Include reproduction/verification steps.
- Before opening: run `pnpm build`, `pnpm typecheck`, and relevant `db:*` tasks.

## Security & Configuration
- Never commit secrets. Base config in `.env.example`; runtime in `.env`.
- Important vars: `DATABASE_URL`, encryption keys, `WEB_APP_URL`, `NEXT_PUBLIC_*`, service ports. For self‑host, see `docker-compose.yml`.
