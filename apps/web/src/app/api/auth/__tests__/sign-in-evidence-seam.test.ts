/**
 * Seam guard: every credential the web app mints says which sign-in ceremony it stands for (D-OW-45, SEC-2/SEC-3).
 *
 * `authentication` is REQUIRED on session and device-token creation, so forgetting it does not compile. What the type
 * cannot tell apart is a sign-in route that verified a ceremony from a route that only derives a credential from an
 * existing one, or one that mints a machine credential. So every production file that mints a session or device token
 * is classified here: a ceremony route must build its evidence with `ceremonyAuthentication` (one source for what each
 * ceremony is worth), a derived credential must NOT (it carries its parent's evidence; minting fresh evidence there
 * would let a token refresh pass for a fresh sign-in), and a machine credential names MACHINE_CREDENTIAL_AUTHENTICATION.
 * A new file is none of these until someone decides, which is the point.
 *
 * Limits, stated: a source scan. The per-route tests prove each route passes the right assurance at the right time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../..');

const CEREMONY = new Set([
  'app/api/auth/magic-link/verify/route.ts',
  'app/api/auth/passkey/authenticate/route.ts',
  'app/api/auth/signup-passkey/route.ts',
  'app/api/auth/google/callback/route.ts',
  'app/api/auth/google/one-tap/route.ts',
  'app/api/auth/google/native/route.ts',
  'app/api/auth/apple/callback/route.ts',
  'app/api/auth/apple/native/route.ts',
  'app/api/auth/mobile/oauth/google/exchange/route.ts',
]);

const DERIVED: Record<string, string> = {
  'app/api/auth/device/refresh/route.ts': 'a session minted from a device token carries the device token evidence',
  'app/api/auth/mobile/refresh/route.ts': 'a session minted from a device token carries the device token evidence',
  'app/api/auth/socket-token/route.ts': 'a socket token carries the session evidence',
  'app/api/auth/ws-token/route.ts': 'a desktop websocket token carries the session evidence',
  'app/api/auth/device/register/route.ts': 'a device token registered for a session carries the session evidence',
  'app/api/account/devices/route.ts': 'a rotated device token carries the replaced token evidence',
  'lib/auth/device-auth-helpers.ts': 'passes its caller evidence through',
};

const MACHINE = new Set(['lib/drive-envs/drive-envs-runtime.ts']);

const MINTS = /sessionService\.createSession\(|validateOrCreateDeviceToken\(|createDeviceTokenRecord\(|create(?:Web)?DeviceToken\(\{/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

const minters = sourceFiles(SRC)
  .map((file) => ({ file: relative(SRC, file), source: readFileSync(file, 'utf8') }))
  .filter(({ source }) => MINTS.test(source));

describe('sign-in evidence seam (D-OW-45)', () => {
  it('SEC-2 (partial) every file that mints a session or device token is classified as a ceremony, a derived credential or a machine credential', () => {
    const unclassified = minters.map((m) => m.file).filter((f) => !CEREMONY.has(f) && !(f in DERIVED) && !MACHINE.has(f));
    expect(unclassified).toEqual([]);
  });

  it('SEC-2 (partial) every sign-in ceremony route records its evidence through ceremonyAuthentication', () => {
    const files = minters.filter((m) => CEREMONY.has(m.file));
    expect(files.map((m) => m.file).sort()).toEqual([...CEREMONY].sort());
    expect(files.filter((m) => !m.source.includes('ceremonyAuthentication(')).map((m) => m.file)).toEqual([]);
  });

  it('SEC-3 (partial) a derived credential never mints fresh evidence, so a refresh never passes for a sign-in', () => {
    expect(minters.filter((m) => m.file in DERIVED && m.source.includes('ceremonyAuthentication(')).map((m) => m.file)).toEqual([]);
  });

  it('a machine credential names that no person signed in for it', () => {
    expect(minters.filter((m) => MACHINE.has(m.file) && !m.source.includes('MACHINE_CREDENTIAL_AUTHENTICATION')).map((m) => m.file)).toEqual([]);
  });
});
