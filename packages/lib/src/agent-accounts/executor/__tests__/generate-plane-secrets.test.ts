/**
 * Slice 1 (deploy) — the one-time secret set for a credential plane and the
 * web process that talks to it. Every generated value must be accepted by the
 * parser that will read it at boot, and the values the two sides must agree on
 * (the authority key pair, the service secret, the presenter key id) must
 * agree. The web side never receives a plane-only value and vice versa.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { generatePlaneSecrets, type PlaneSecretPrimitives } from '../generate-plane-secrets';
import { parsePlaneEnv } from '../parse-plane-env';
import { loadAccountAuthorityKeyring } from '../../../auth/account-authority-signing-key';

const primitives: PlaneSecretPrimitives = {
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  generateEd25519: () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      pkcs8Der: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })),
      spkiDer: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    };
  },
};

const PLANE_URL = 'http://pagespace-credential-plane.internal:3011';
/** What the operator sets on the plane separately (not secrets this generator owns). */
const OPERATOR_PLANE_ENV = {
  INFISICAL_URL: 'http://pagespace-infisical.internal:8080',
  INFISICAL_ORG_ID: 'org_1',
  INFISICAL_PROVISIONER_CLIENT_ID: 'client',
  INFISICAL_PROVISIONER_CLIENT_SECRET: 'secret',
  PLANE_METADATA_DATABASE_URL: 'postgresql://plane:pw@pagespace-plane-db.internal:5432/plane_metadata',
};

describe('generatePlaneSecrets', () => {
  const { plane, web } = generatePlaneSecrets({ planeUrl: PLANE_URL, primitives });

  it('given the plane side plus the operator-set values, should be accepted by parsePlaneEnv', () => {
    const verdict = parsePlaneEnv({ env: { ...plane, ...OPERATOR_PLANE_ENV } });
    expect(verdict.ok).toBe(true);
  });

  // The four variables apps/web/src/lib/agent-accounts/agent-accounts-config.ts requires before it
  // offers the tools (packages/lib must not import apps/web, so the names are stated here).
  it('given the web side, should carry exactly the variables that switch agent accounts on, each non-empty', () => {
    const actual = Object.entries(web).map(([name, value]) => [name, value.length > 0]).sort();
    const expected = [
      ['ACCOUNT_AUTHORITY_SIGNING_KEY', true],
      ['AGENT_ACCOUNTS_PLANE_SERVICE_SECRET', true],
      ['AGENT_ACCOUNTS_PLANE_URL', true],
      ['AGENT_ACCOUNTS_PRESENTER_KEY_ID', true],
    ];
    expect(actual).toEqual(expected);
  });

  it('given the web signing key, should derive exactly the public key the plane verifies with', () => {
    const keyring = loadAccountAuthorityKeyring(web);
    expect(Buffer.from(keyring.current.publicKey).toString('base64')).toBe(plane.ACCOUNT_AUTHORITY_PUBLIC_KEY);
  });

  it('given both sides, should share the service secret and presenter key id', () => {
    const actual = [web.AGENT_ACCOUNTS_PLANE_SERVICE_SECRET === plane.AGENT_ACCOUNTS_PLANE_SERVICE_SECRET, web.AGENT_ACCOUNTS_PRESENTER_KEY_ID === plane.AGENT_ACCOUNTS_PRESENTER_KEY_ID];
    expect(actual).toEqual([true, true]);
  });

  it('given the split, should never hand the web side a plane-only value or the plane the signing key', () => {
    const actual = { webHasDigestKey: 'AGENT_ACCOUNTS_WRITE_DIGEST_KEY' in web, planeHasSigningKey: 'ACCOUNT_AUTHORITY_SIGNING_KEY' in plane };
    expect(actual).toEqual({ webHasDigestKey: false, planeHasSigningKey: false });
  });

  it('given two runs, should never repeat a secret', () => {
    const again = generatePlaneSecrets({ planeUrl: PLANE_URL, primitives });
    const actual = [
      again.plane.AGENT_ACCOUNTS_PLANE_SERVICE_SECRET === plane.AGENT_ACCOUNTS_PLANE_SERVICE_SECRET,
      again.plane.AGENT_ACCOUNTS_WRITE_DIGEST_KEY === plane.AGENT_ACCOUNTS_WRITE_DIGEST_KEY,
      again.web.ACCOUNT_AUTHORITY_SIGNING_KEY === web.ACCOUNT_AUTHORITY_SIGNING_KEY,
    ];
    expect(actual).toEqual([false, false, false]);
  });
});
