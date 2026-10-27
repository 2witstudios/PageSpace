// Bundle the pure env-bridge core into the CLI dist (see src/env-bridge/lib-core.ts).
// Runs after tsc: the emitted dist/env-bridge/lib-core.js (which still imports
// @pagespace/lib) is replaced by a self-contained ESM module built from the
// library's SOURCE tree. Only I/O-free modules are reachable from lib-core.ts;
// zod and node builtins stay external.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..');
const libSrc = path.resolve(cli, '..', 'lib', 'src');

const result = await build({
  entryPoints: [path.join(cli, 'src', 'env-bridge', 'lib-core.ts')],
  outfile: path.join(cli, 'dist', 'env-bridge', 'lib-core.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  alias: { '@pagespace/lib': libSrc },
  external: ['zod'],
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs);
const outside = inputs.filter((file) => !file.includes('/lib/src/env-bridge/') && !file.endsWith('src/env-bridge/lib-core.ts'));
if (outside.length > 0) {
  console.error(`bundle-lib-core: refusing — non-pure-core inputs were pulled in:\n  ${outside.join('\n  ')}`);
  process.exit(1);
}
console.log(`bundle-lib-core: inlined ${inputs.length - 1} pure-core modules into dist/env-bridge/lib-core.js`);
