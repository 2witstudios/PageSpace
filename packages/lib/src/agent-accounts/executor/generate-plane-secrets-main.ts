/**
 * `bun run --filter @pagespace/lib credential-plane:secrets -- <out-dir> [plane-url]`
 *
 * Generates the plane/web secret set once (`generatePlaneSecrets`) and writes
 * it as two env files, mode 0600, in a NEW directory:
 *   <out-dir>/plane.env  →  flyctl secrets import --app pagespace-credential-plane < plane.env
 *   <out-dir>/web.env    →  flyctl secrets import --app pagespace-web < web.env   (this turns the feature ON)
 * Prints only paths and variable names, never a value. Delete the directory
 * once imported; the signing key's only other copy is the web app's secrets.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generatePlaneSecrets } from './generate-plane-secrets';

const DEFAULT_PLANE_URL = 'http://pagespace-credential-plane.internal:3011';
const [outDir, planeUrl = DEFAULT_PLANE_URL] = process.argv.slice(2);
if (outDir === undefined || outDir.trim().length === 0) {
  process.stderr.write('usage: credential-plane:secrets <new-output-dir> [plane-url]\n');
  process.exit(1);
}

const secrets = generatePlaneSecrets({
  planeUrl,
  primitives: {
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
    generateEd25519: () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      return {
        pkcs8Der: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })),
        spkiDer: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      };
    },
  },
});

// A new directory only: never overwrite an earlier set that may already be imported somewhere.
mkdirSync(outDir, { recursive: false, mode: 0o700 });
const write = (name: string, values: Record<string, string>) => {
  const file = path.join(outDir, name);
  writeFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${file}: ${Object.keys(values).join(', ')}\n`);
};
write('plane.env', secrets.plane);
write('web.env', secrets.web);
process.stdout.write('Import plane.env first; web.env switches agent accounts on. Delete this directory afterwards.\n');
