/**
 * L2·G2 — `parsePlaneEnv`: the credential plane's process configuration.
 * Every secret the plane holds arrives here and nowhere else (ADR 0005 §7:
 * process secrets, never the main DB): the service secret shared with the web
 * process, the provisioner credential, the plane metadata DB, the write-digest
 * key, and the authority's PUBLIC key (the plane verifies grants; it never
 * holds the signing key). A missing or malformed value refuses the whole
 * start with the variable names at fault — a plane that started half
 * configured would refuse every request later and look like a bug.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { parsePlaneEnv } from '../parse-plane-env';

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const env = {
  AGENT_ACCOUNTS_PLANE_SERVICE_SECRET: 'x'.repeat(40),
  AGENT_ACCOUNTS_WRITE_DIGEST_KEY: randomBytes(32).toString('base64'),
  ACCOUNT_AUTHORITY_PUBLIC_KEY: publicKey,
  AGENT_ACCOUNTS_PRESENTER_KEY_ID: 'plane-http-1',
  INFISICAL_URL: 'http://infisical.internal:8080',
  INFISICAL_ORG_ID: 'org_1',
  INFISICAL_PROVISIONER_CLIENT_ID: 'cid',
  INFISICAL_PROVISIONER_CLIENT_SECRET: 'csecret',
  PLANE_METADATA_DATABASE_URL: 'postgres://plane@db/plane',
};

describe('parsePlaneEnv', () => {
  it('given a complete environment, should produce the plane configuration with defaults for port and Infisical environment', () => {
    const verdict = parsePlaneEnv({ env });
    const actual = verdict.ok ? { port: verdict.config.port, environment: verdict.config.infisicalEnvironment, provisioner: verdict.config.provisioner.kind, keyId: verdict.config.presenterKeyId, publicKeyBytes: verdict.config.authorityPublicKey.length > 0 } : verdict;
    const expected = { port: 3011, environment: 'prod', provisioner: 'universal_auth', keyId: 'plane-http-1', publicKeyBytes: true };
    expect(actual).toEqual(expected);
  });

  it('given missing variables, should refuse naming every one of them', () => {
    const { INFISICAL_URL: _url, PLANE_METADATA_DATABASE_URL: _db, ...partial } = env;
    const actual = parsePlaneEnv({ env: partial });
    const expected = { ok: false, missing: ['INFISICAL_URL', 'PLANE_METADATA_DATABASE_URL'], malformed: [] };
    expect(actual).toEqual(expected);
  });

  it('given a short service secret, a short digest key, a non-key public key or no provisioner credential, should refuse naming them', () => {
    const actual = parsePlaneEnv({
      env: { ...env, AGENT_ACCOUNTS_PLANE_SERVICE_SECRET: 'short', AGENT_ACCOUNTS_WRITE_DIGEST_KEY: randomBytes(8).toString('base64'), ACCOUNT_AUTHORITY_PUBLIC_KEY: 'not-base64!', INFISICAL_PROVISIONER_CLIENT_ID: undefined, INFISICAL_PROVISIONER_CLIENT_SECRET: undefined },
    });
    const expected = { ok: false, missing: ['INFISICAL_PROVISIONER_CLIENT_ID'], malformed: ['AGENT_ACCOUNTS_PLANE_SERVICE_SECRET', 'AGENT_ACCOUNTS_WRITE_DIGEST_KEY', 'ACCOUNT_AUTHORITY_PUBLIC_KEY'] };
    expect(actual).toEqual(expected);
  });

  it('given a provisioner token instead of a client id and secret, should use the token (local development)', () => {
    const verdict = parsePlaneEnv({ env: { ...env, INFISICAL_PROVISIONER_CLIENT_ID: undefined, INFISICAL_PROVISIONER_CLIENT_SECRET: undefined, INFISICAL_PROVISIONER_TOKEN: 'tok' } });
    const actual = verdict.ok ? verdict.config.provisioner : verdict;
    const expected = { kind: 'token', token: 'tok' };
    expect(actual).toEqual(expected);
  });
});
