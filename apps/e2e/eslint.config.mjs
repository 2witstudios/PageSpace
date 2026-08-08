import tseslint from 'typescript-eslint';

/**
 * apps/e2e had neither `lint` nor `typecheck` until now, so its 17 Playwright
 * specs plus the harness (global setup/teardown, fixtures, the mock OpenRouter
 * server) could stop compiling entirely without a single check going red — the
 * `agent_sessions` → `agent_workspaces` rename touched this app and nothing
 * here would have caught the drift.
 *
 * Rule set mirrors apps/realtime: the shared barrel-import policy plus
 * typescript-eslint's non-type-aware recommended rules (no type-aware program
 * here — these files import from the web app's runtime, not a tsconfig
 * project).
 */
export default [
  {
    ignores: ['node_modules/**', 'playwright-report/**', 'test-results/**', 'storageState.json'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,mjs}'],
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      // Same `_`-prefix escape hatch apps/web and apps/admin use.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pagespace/db',
              message:
                'Use subpath imports: @pagespace/db/db, @pagespace/db/operators, or @pagespace/db/schema/<name>',
            },
            {
              name: '@pagespace/lib',
              message:
                'Use a specific subpath import e.g. @pagespace/lib/auth/session-service',
            },
          ],
        },
      ],
    },
  },
];
