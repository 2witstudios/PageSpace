import { defineConfig } from 'vitest/config';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    exclude: [
      // Integration tests that require a running PostgreSQL database
      'src/app/api/admin/users/*/gift-subscription/__tests__/route.security.test.ts',
    ],
    setupFiles: ['./src/test/setup.ts'],
  },
  resolve: {
    // Array form: specific aliases first, then a regex catch-all for any other
    // @pagespace/lib/* subpath (e.g. services/drive-service) so new lib imports don't
    // each need an explicit alias. Mirrors the tsconfig paths glob.
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '@pagespace/db/db', replacement: path.resolve(repoRoot, 'packages/db/src/db.ts') },
      { find: '@pagespace/db/operators', replacement: path.resolve(repoRoot, 'packages/db/src/operators.ts') },
      { find: '@pagespace/db/schema/auth', replacement: path.resolve(repoRoot, 'packages/db/src/schema/auth.ts') },
      { find: '@pagespace/db/schema/core', replacement: path.resolve(repoRoot, 'packages/db/src/schema/core.ts') },
      { find: '@pagespace/db/schema/monitoring', replacement: path.resolve(repoRoot, 'packages/db/src/schema/monitoring.ts') },
      { find: '@pagespace/db/schema/sessions', replacement: path.resolve(repoRoot, 'packages/db/src/schema/sessions.ts') },
      { find: '@pagespace/db/schema/subscriptions', replacement: path.resolve(repoRoot, 'packages/db/src/schema/subscriptions.ts') },
      { find: '@pagespace/db/schema/contact', replacement: path.resolve(repoRoot, 'packages/db/src/schema/contact.ts') },
      { find: '@pagespace/db/schema/members', replacement: path.resolve(repoRoot, 'packages/db/src/schema/members.ts') },
      { find: '@pagespace/db', replacement: path.resolve(repoRoot, 'packages/db/src/index.ts') },
      { find: '@pagespace/lib/auth/session-service', replacement: path.resolve(repoRoot, 'packages/lib/src/auth/session-service.ts') },
      { find: '@pagespace/lib/auth/magic-link-service', replacement: path.resolve(repoRoot, 'packages/lib/src/auth/magic-link-service.ts') },
      { find: '@pagespace/lib/auth/constants', replacement: path.resolve(repoRoot, 'packages/lib/src/auth/constants.ts') },
      { find: '@pagespace/lib/audit/audit-log', replacement: path.resolve(repoRoot, 'packages/lib/src/audit/audit-log.ts') },
      { find: /^@pagespace\/lib\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/lib/src/$1') },
    ],
  },
});
