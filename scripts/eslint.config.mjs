import tseslint from 'typescript-eslint';

export default [
  {
    files: ['**/*.{ts,mjs}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: { parser: tseslint.parser },
    rules: {
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
            {
              name: '@pagespace/lib/audit',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/audit/audit-log, not @pagespace/lib/audit)',
            },
            {
              name: '@pagespace/lib/auth',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/auth/session-service, not @pagespace/lib/auth)',
            },
            {
              name: '@pagespace/lib/content',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/content/tree-utils, not @pagespace/lib/content)',
            },
            {
              name: '@pagespace/lib/encryption',
              message:
                'Use the specific leaf subpath: @pagespace/lib/encryption/encryption-utils',
            },
            {
              name: '@pagespace/lib/integrations',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/integrations/types, not @pagespace/lib/integrations)',
            },
            {
              name: '@pagespace/lib/integrations/providers',
              message:
                'Use @pagespace/lib/integrations/providers/builtin-providers',
            },
            {
              name: '@pagespace/lib/logging',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/logging/logger-config, not @pagespace/lib/logging)',
            },
            {
              name: '@pagespace/lib/monitoring',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/monitoring/activity-tracker, not @pagespace/lib/monitoring)',
            },
            {
              name: '@pagespace/lib/notifications',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/notifications/notifications, not @pagespace/lib/notifications)',
            },
            {
              name: '@pagespace/lib/permissions',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/permissions/permissions, not @pagespace/lib/permissions)',
            },
            {
              name: '@pagespace/lib/repositories',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/repositories/page-repository, not @pagespace/lib/repositories)',
            },
            {
              name: '@pagespace/lib/security',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/security/url-validator, not @pagespace/lib/security)',
            },
            {
              name: '@pagespace/lib/sheets',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/sheets/sheet, not @pagespace/lib/sheets)',
            },
            {
              name: '@pagespace/lib/utils',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/utils/enums, not @pagespace/lib/utils)',
            },
            {
              name: '@pagespace/lib/validators',
              message:
                'Use the specific leaf subpath (e.g. @pagespace/lib/validators/id-validators, not @pagespace/lib/validators)',
            },
          ],
        },
      ],
    },
  },
];
