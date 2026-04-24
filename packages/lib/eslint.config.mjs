import tseslint from 'typescript-eslint';

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
            {
              name: './index',
              message: 'Use direct subpath imports instead of the barrel',
            },
            {
              name: '../index',
              message: 'Use direct subpath imports instead of the barrel',
            },
          ],
        },
      ],
    },
  },
];
