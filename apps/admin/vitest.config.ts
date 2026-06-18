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
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@pagespace/db/db': path.resolve(repoRoot, 'packages/db/src/db.ts'),
      '@pagespace/db/operators': path.resolve(repoRoot, 'packages/db/src/operators.ts'),
      '@pagespace/db/schema/auth': path.resolve(repoRoot, 'packages/db/src/schema/auth.ts'),
      '@pagespace/db/schema/core': path.resolve(repoRoot, 'packages/db/src/schema/core.ts'),
      '@pagespace/db/schema/monitoring': path.resolve(repoRoot, 'packages/db/src/schema/monitoring.ts'),
      '@pagespace/db/schema/sessions': path.resolve(repoRoot, 'packages/db/src/schema/sessions.ts'),
      '@pagespace/db/schema/subscriptions': path.resolve(repoRoot, 'packages/db/src/schema/subscriptions.ts'),
      '@pagespace/db/schema/contact': path.resolve(repoRoot, 'packages/db/src/schema/contact.ts'),
      '@pagespace/db/schema/members': path.resolve(repoRoot, 'packages/db/src/schema/members.ts'),
      '@pagespace/db': path.resolve(repoRoot, 'packages/db/src/index.ts'),
      '@pagespace/lib/auth/session-service': path.resolve(repoRoot, 'packages/lib/src/auth/session-service.ts'),
      '@pagespace/lib/auth/magic-link-service': path.resolve(repoRoot, 'packages/lib/src/auth/magic-link-service.ts'),
      '@pagespace/lib/auth/constants': path.resolve(repoRoot, 'packages/lib/src/auth/constants.ts'),
      '@pagespace/lib/audit/audit-log': path.resolve(repoRoot, 'packages/lib/src/audit/audit-log.ts'),
      '@pagespace/lib': path.resolve(repoRoot, 'packages/lib/src/index.ts'),
    },
  },
});
