import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
// Note: vite-tsconfig-paths removed due to ESM compatibility issue
// Using manual path alias instead

const packagesDir = path.resolve(__dirname, '../../packages')

// In pnpm git worktrees the local node_modules may be empty (no pnpm install
// was run in the worktree). Walk up the directory tree to find the workspace
// root's .pnpm/node_modules so that Next.js and other packages can be resolved
// by Vite during test collection.
function findPnpmNodeModules(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', '.pnpm', 'node_modules');
    if (fs.existsSync(path.join(candidate, 'next'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const workspaceNodeModules = findPnpmNodeModules(__dirname)

// Build a Vite alias entry for a package from the shared pnpm store.
// Only used when local node_modules are absent (git worktree scenario).
function pnpmAlias(pkg: string, subpath: string, pnpmModules: string): Record<string, string> {
  const fullPath = path.join(pnpmModules, subpath);
  return fs.existsSync(fullPath) ? { [pkg]: fullPath } : {};
}

const worktreeAliases = workspaceNodeModules ? {
  'next/server': path.join(workspaceNodeModules, 'next', 'server.js'),
  'next/headers': path.join(workspaceNodeModules, 'next', 'headers.js'),
  'next/navigation': path.join(workspaceNodeModules, 'next', 'navigation.js'),
  'next/cache': path.join(workspaceNodeModules, 'next', 'cache.js'),
  'next': path.join(workspaceNodeModules, 'next', 'dist', 'index.js'),
  ...pnpmAlias('date-fns', 'date-fns/index.js', workspaceNodeModules),
  ...pnpmAlias('zod/v4', 'zod/v4/index.js', workspaceNodeModules),
  ...pnpmAlias('zod', 'zod/index.js', workspaceNodeModules),
} : {}

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/.next/**',
        '**/dist/**',
        '**/test/**',
        '**/drizzle/**',
        '**/node_modules/**',
      ],
      thresholds: {
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
      },
    },
  },
  resolve: {
    alias: {
      // Worktree fallback: resolves packages from the shared pnpm store when
      // local node_modules are empty. Has no effect in CI or full installs.
      ...worktreeAliases,
      '@': path.resolve(__dirname, './src'),
      // Workspace package aliases for testing
      '@pagespace/db/test/factories': path.resolve(packagesDir, 'db/src/test/factories'),
      '@pagespace/db': path.resolve(packagesDir, 'db/src'),
      '@pagespace/lib/server': path.resolve(packagesDir, 'lib/src/server'),
      '@pagespace/lib/broadcast-auth': path.resolve(packagesDir, 'lib/src/auth/broadcast-auth'),
      '@pagespace/lib/logger-browser': path.resolve(packagesDir, 'lib/src/logging/logger-browser'),
      '@pagespace/lib/utils/environment': path.resolve(packagesDir, 'lib/src/utils/environment'),
      '@pagespace/lib/ai-context-calculator': path.resolve(packagesDir, 'lib/src/monitoring/ai-context-calculator'),
      '@pagespace/lib/ai-monitoring': path.resolve(packagesDir, 'lib/src/monitoring/ai-monitoring'),
      '@pagespace/lib/auth-utils': path.resolve(packagesDir, 'lib/src/auth/auth-utils'),
      '@pagespace/lib/services/subscription-utils': path.resolve(packagesDir, 'lib/src/services/subscription-utils'),
      '@pagespace/lib/services/storage-limits': path.resolve(packagesDir, 'lib/src/services/storage-limits'),
      '@pagespace/lib/verification-utils': path.resolve(packagesDir, 'lib/src/auth/verification-utils'),
      '@pagespace/lib/device-auth-utils': path.resolve(packagesDir, 'lib/src/auth/device-auth-utils'),
      '@pagespace/lib/activity-tracker': path.resolve(packagesDir, 'lib/src/monitoring/activity-tracker'),
      '@pagespace/lib/services/email-service': path.resolve(packagesDir, 'lib/src/services/email-service'),
      '@pagespace/lib/email-templates/VerificationEmail': path.resolve(packagesDir, 'lib/src/email-templates/VerificationEmail'),
      '@pagespace/lib/api-utils': path.resolve(packagesDir, 'lib/src/utils/api-utils'),
      '@pagespace/lib/audit/security-audit': path.resolve(packagesDir, 'lib/src/audit/security-audit'),
      '@pagespace/lib/audit/mask-email': path.resolve(packagesDir, 'lib/src/audit/mask-email'),
      '@pagespace/lib/security': path.resolve(packagesDir, 'lib/src/security'),
      '@pagespace/lib/secure-compare': path.resolve(packagesDir, 'lib/src/auth/secure-compare'),
      '@pagespace/lib/auth': path.resolve(packagesDir, 'lib/src/auth'),
      // Fallback for general @pagespace/lib imports
      '@pagespace/lib': path.resolve(packagesDir, 'lib/src'),
    },
  },
})
