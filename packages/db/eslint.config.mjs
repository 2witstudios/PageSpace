import tseslint from 'typescript-eslint';

export default [
  {
    files: ['src/**/*.{ts,tsx,js,mjs}'],
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
              message: 'Use subpath imports: ./db, ./operators, or ./schema/<name>',
            },
            {
              name: '../index',
              message: 'Use subpath imports: ../db, ../operators, or ../schema/<name>',
            },
          ],
        },
      ],
    },
  },
];
