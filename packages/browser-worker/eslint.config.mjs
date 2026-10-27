import tseslint from 'typescript-eslint';

// Barrel-free and subpath-only like packages/lib and packages/editor: a
// barrel import is an error.
//
// The worker is the only CDP client of its Chromium, and the brief (G6a)
// forbids it every surface through which page state could leave the browser
// other than the typed operations: no raw CDP session, no script evaluation,
// no cookie or storage API, no downloads. Those are refused HERE, at lint
// time, on every file of the package, so adding one is a visible rule change
// rather than a quiet call.
const TYPED_ONLY = 'G6a: the browser worker exposes typed operations only (no raw CDP, JS eval, cookie/storage APIs or downloads)';

const FORBIDDEN_BROWSER_METHODS = [
  'newCDPSession',
  'evaluate',
  'evaluateHandle',
  'evaluateAll',
  '$eval',
  '$$eval',
  'addInitScript',
  'addScriptTag',
  'exposeFunction',
  'exposeBinding',
  'cookies',
  'addCookies',
  'clearCookies',
  'storageState',
  'setStorageState',
  'waitForEvent',
];

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.ts'],
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
          ],
          patterns: [{ group: ['@/*'], message: 'apps/web aliases are unreachable from a workspace package' }],
        },
      ],
      'no-restricted-properties': [
        'error',
        ...FORBIDDEN_BROWSER_METHODS.map((property) => ({ property, message: TYPED_ONLY })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ClassDeclaration', message: 'Control Board §7.6: no classes' },
        { selector: 'TSInterfaceDeclaration', message: 'Control Board §7.5: `type`, never `interface`' },
        { selector: 'ThisExpression', message: 'Control Board §7.6: no `this`' },
      ],
    },
  },
];
