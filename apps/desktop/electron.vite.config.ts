import { defineConfig } from 'electron-vite';
import { resolve } from 'path';
import { outRootFor } from './src/shared/out-root';

/**
 * One codebase, two apps. `PAGESPACE_APP_VARIANT` selects which one this build
 * is; see `src/shared/app-identity.ts` for the registry.
 *
 * The variant is baked into the bundle, so the two builds MUST NOT share an
 * output directory — a coder bundle sitting where the PageSpace packager looks
 * would produce a PageSpace-branded installer running the coder app. Hence the
 * variant-scoped `outRoot`, matched by disjoint `files` globs in the two
 * electron-builder configs.
 */
const variant = process.env.PAGESPACE_APP_VARIANT ?? 'pagespace';

// Shared with the dev scripts and the packaging configs — see out-root.ts for
// why all three have to agree, and build-config-drift.test.ts for the guard.
const outRoot = outRootFor(variant);

const define = { __APP_VARIANT__: JSON.stringify(variant) };

export default defineConfig({
  main: {
    define,
    build: {
      outDir: `${outRoot}/main`,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        output: {
          format: 'es',
        },
        external: ['bufferutil', 'utf-8-validate', 'zod', 'node-machine-id'],
      },
    },
  },
  preload: {
    define,
    build: {
      outDir: `${outRoot}/preload`,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
});
