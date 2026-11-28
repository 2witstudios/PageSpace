/**
 * `generatePlaneSecrets` — the one-time secret set for a credential plane and
 * the web process that calls it (slice 1, deploy). Pure: randomness and the
 * Ed25519 key generator are injected.
 *
 * The split is the ADR 0005 §3.4 boundary, not a convenience:
 * - the web side gets the grant-SIGNING key, the consent-SIGNING key, the plane
 *   URL, the service secret and the presenter key id — nothing that reads
 *   material;
 * - the plane side gets the authority's PUBLIC key and the consent PUBLIC key
 *   (it verifies, never signs), the service secret, the presenter key id and
 *   the pending-write digest key.
 * Values the two must agree on are generated once and placed on both sides.
 * Infisical, database and provisioner values are the operator's, not this
 * generator's.
 */

export type PlaneSecretPrimitives = {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly generateEd25519: () => { readonly pkcs8Der: Uint8Array; readonly spkiDer: Uint8Array };
};

export type PlaneSecretSet = {
  readonly plane: {
    readonly AGENT_ACCOUNTS_PLANE_SERVICE_SECRET: string;
    readonly AGENT_ACCOUNTS_PRESENTER_KEY_ID: string;
    readonly AGENT_ACCOUNTS_WRITE_DIGEST_KEY: string;
    readonly ACCOUNT_AUTHORITY_PUBLIC_KEY: string;
    readonly AGENT_ACCOUNTS_CONSENT_PUBLIC_KEY: string;
  };
  readonly web: {
    readonly AGENT_ACCOUNTS_PLANE_URL: string;
    readonly AGENT_ACCOUNTS_PLANE_SERVICE_SECRET: string;
    readonly AGENT_ACCOUNTS_PRESENTER_KEY_ID: string;
    readonly ACCOUNT_AUTHORITY_SIGNING_KEY: string;
    readonly AGENT_ACCOUNTS_CONSENT_SIGNING_KEY: string;
  };
};

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function generatePlaneSecrets({ planeUrl, primitives }: { readonly planeUrl: string; readonly primitives: PlaneSecretPrimitives }): PlaneSecretSet {
  const serviceSecret = hex(primitives.randomBytes(32));
  const presenterKeyId = `http-executor-${hex(primitives.randomBytes(8))}`;
  const authority = primitives.generateEd25519();
  const consent = primitives.generateEd25519();
  return {
    plane: {
      AGENT_ACCOUNTS_PLANE_SERVICE_SECRET: serviceSecret,
      AGENT_ACCOUNTS_PRESENTER_KEY_ID: presenterKeyId,
      AGENT_ACCOUNTS_WRITE_DIGEST_KEY: base64(primitives.randomBytes(32)),
      ACCOUNT_AUTHORITY_PUBLIC_KEY: base64(authority.spkiDer),
      AGENT_ACCOUNTS_CONSENT_PUBLIC_KEY: base64(consent.spkiDer),
    },
    web: {
      AGENT_ACCOUNTS_PLANE_URL: planeUrl,
      AGENT_ACCOUNTS_PLANE_SERVICE_SECRET: serviceSecret,
      AGENT_ACCOUNTS_PRESENTER_KEY_ID: presenterKeyId,
      ACCOUNT_AUTHORITY_SIGNING_KEY: base64(authority.pkcs8Der),
      AGENT_ACCOUNTS_CONSENT_SIGNING_KEY: base64(consent.pkcs8Der),
    },
  };
}
