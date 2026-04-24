import tseslint from 'typescript-eslint';

export default [
  {
    files: ['src/**/*.{ts,tsx,js,mjs}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@pagespace/db",
              message:
                "Use subpath imports: @pagespace/db/db, @pagespace/db/operators, or @pagespace/db/schema/<name>",
            },
            {
              name: "@pagespace/lib",
              message:
                "Use direct subpath imports: @pagespace/lib/<module>/<file>",
            },
          ],
        },
      ],
    },
  },
];
