import tseslint from 'typescript-eslint';

/**
 * The coding standard, as executable rules. This config is NOT the per-package
 * lint config — it is the strict rule set the quality gate
 * (scripts/quality/quality-gate.mjs) runs across every app and package source
 * tree, with all existing violations frozen in quality-baseline.json.
 *
 * Rules here must be syntax-only (no type-aware linting): the gate lints the
 * whole monorepo in one pass and type-aware rules would make that pass slow
 * and project-config-dependent. Every rule maps to a stated standard:
 *
 *   - No `any` (CLAUDE.md): no-explicit-any, ban-ts-comment.
 *   - Pure functions / no input mutation: no-param-reassign (incl. props),
 *     prefer-const, no-var.
 *   - Small composable functions over deep imperative blocks: complexity,
 *     max-depth, max-lines-per-function, max-params, max-nested-callbacks.
 *   - No sloppy equality: eqeqeq (null-check idiom allowed).
 *
 * Raising the bar = add a rule here (or tighten a limit), run
 * `bun run quality:update` to absorb existing violations, commit both. The
 * baseline diff then tracks the refactor to zero.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/generated/**',
      'packages/db/drizzle/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': { descriptionFormat: '^: .+' },
          'ts-ignore': true,
          'ts-nocheck': true,
        },
      ],
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-lines-per-function': [
        'error',
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: false },
      ],
      'max-params': ['error', 4],
      'max-nested-callbacks': ['error', 4],
      'no-param-reassign': ['error', { props: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Tests hold to the same standard with two relaxations: describe/it blocks
    // are structurally long (max-lines-per-function would only measure suite
    // size, not function quality), and deeply nested callbacks are the test
    // DSL itself. `any` stays banned in tests — a test that lies about types
    // proves nothing.
    files: [
      '**/__tests__/**/*.{ts,tsx,mts,cts}',
      '**/*.test.{ts,tsx,mts,cts}',
      '**/*.spec.{ts,tsx,mts,cts}',
    ],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
];
