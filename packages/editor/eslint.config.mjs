import tseslint from 'typescript-eslint';

// Mirrors packages/lib: this package is barrel-free and subpath-only (no
// `main`, no `"."` export), so a barrel import is an error here too.
// It is also React-free by contract — a headless Node collab service
// imports it — so anything React/DOM-flavoured is refused at lint time, not
// discovered at runtime when that service fails to boot.
const REACT_FREE = '@pagespace/editor is React-free; client-only code lives in apps/web';

export default [
  {
    files: ['src/**/*.{ts,tsx,js,mjs}'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: './index', message: 'Use direct subpath imports instead of the barrel' },
            { name: '../index', message: 'Use direct subpath imports instead of the barrel' },
            ...['react', 'react-dom', '@tiptap/react'].map((name) => ({ name, message: REACT_FREE })),
          ],
          patterns: [
            { group: ['@/*'], message: 'apps/web aliases are unreachable from a workspace package' },
            { group: ['shiki', 'shiki/*', 'tippy.js', 'tippy.js/*'], message: '@pagespace/editor is DOM-free; view-layer code lives in apps/web' },
          ],
        },
      ],
    },
  },
];
