/**
 * `parsePlaneEnv` — the credential plane process's configuration (L2·G2;
 * ADR 0005 §7). Pure. Every secret the plane holds arrives through here and
 * nowhere else; the plane holds the authority's PUBLIC key only (it verifies
 * grants, it never signs them). A missing or malformed value refuses the whole
 * start, naming the variables — never a half-configured plane that refuses
 * every request later.
 */
import { decodeBase64 } from '../decode-base64';
import { parseWriteDigestKey, WRITE_DIGEST_KEY_VAR } from '../store/parse-write-digest-key';
import type { WriteDigestKey } from '../store/store-adapter';
import type { ProvisionerAuth } from '../store/infisical-tenant-provisioner-client';
import type { PresenterKeyId } from '../grant';

export type PlaneConfig = {
  readonly port: number;
  readonly serviceSecret: string;
  readonly writeDigestKey: WriteDigestKey;
  /** DER SPKI of the account authority's Ed25519 key. */
  readonly authorityPublicKey: Uint8Array;
  readonly presenterKeyId: PresenterKeyId;
  readonly infisicalUrl: string;
  readonly infisicalOrgId: string;
  readonly infisicalEnvironment: string;
  readonly provisioner: ProvisionerAuth;
  readonly metadataDatabaseUrl: string;
  /** DER SPKI of the step-up consent key; null = no rebind can be consented (none is needed in this slice). */
  readonly consentPublicKey: Uint8Array | null;
};

export type PlaneEnvVerdict = { readonly ok: true; readonly config: PlaneConfig } | { readonly ok: false; readonly missing: readonly string[]; readonly malformed: readonly string[] };

const MIN_SERVICE_SECRET_LENGTH = 32;
const DEFAULT_PORT = 3011;

export function parsePlaneEnv({ env }: { readonly env: Readonly<Record<string, string | undefined>> }): PlaneEnvVerdict {
  const missing: string[] = [];
  const malformed: string[] = [];
  const read = (name: string): string | null => {
    const value = env[name]?.trim() ?? '';
    if (value.length === 0) {
      missing.push(name);
      return null;
    }
    return value;
  };

  const serviceSecret = read('AGENT_ACCOUNTS_PLANE_SERVICE_SECRET');
  if (serviceSecret !== null && serviceSecret.length < MIN_SERVICE_SECRET_LENGTH) malformed.push('AGENT_ACCOUNTS_PLANE_SERVICE_SECRET');

  const digestRaw = read(WRITE_DIGEST_KEY_VAR);
  const digest = digestRaw === null ? null : parseWriteDigestKey({ raw: digestRaw });
  if (digest !== null && !digest.ok) malformed.push(WRITE_DIGEST_KEY_VAR);

  const publicRaw = read('ACCOUNT_AUTHORITY_PUBLIC_KEY');
  const authorityPublicKey = publicRaw === null ? null : decodeBase64(publicRaw);
  if (publicRaw !== null && (authorityPublicKey === null || authorityPublicKey.length < 32)) malformed.push('ACCOUNT_AUTHORITY_PUBLIC_KEY');

  const presenterKeyId = read('AGENT_ACCOUNTS_PRESENTER_KEY_ID');
  const infisicalUrl = read('INFISICAL_URL');
  const infisicalOrgId = read('INFISICAL_ORG_ID');
  const metadataDatabaseUrl = read('PLANE_METADATA_DATABASE_URL');

  const token = env.INFISICAL_PROVISIONER_TOKEN?.trim() ?? '';
  let provisioner: ProvisionerAuth | null = null;
  if (token.length > 0) provisioner = { kind: 'token', token };
  else {
    const clientId = read('INFISICAL_PROVISIONER_CLIENT_ID');
    const clientSecret = clientId === null ? null : read('INFISICAL_PROVISIONER_CLIENT_SECRET');
    if (clientId !== null && clientSecret !== null) provisioner = { kind: 'universal_auth', clientId, clientSecret };
  }

  const portRaw = env.AGENT_ACCOUNTS_PLANE_PORT?.trim() ?? '';
  const port = portRaw.length === 0 ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) malformed.push('AGENT_ACCOUNTS_PLANE_PORT');

  const consentRaw = env.AGENT_ACCOUNTS_CONSENT_PUBLIC_KEY?.trim() ?? '';
  const consentPublicKey = consentRaw.length === 0 ? null : decodeBase64(consentRaw);
  if (consentRaw.length > 0 && consentPublicKey === null) malformed.push('AGENT_ACCOUNTS_CONSENT_PUBLIC_KEY');

  if (missing.length > 0 || malformed.length > 0) return { ok: false, missing, malformed };
  return {
    ok: true,
    config: {
      port,
      serviceSecret: serviceSecret!,
      writeDigestKey: (digest as Extract<typeof digest, { ok: true }>).key,
      authorityPublicKey: authorityPublicKey!,
      presenterKeyId: presenterKeyId! as PresenterKeyId,
      infisicalUrl: infisicalUrl!,
      infisicalOrgId: infisicalOrgId!,
      infisicalEnvironment: env.INFISICAL_ENVIRONMENT?.trim() || 'prod',
      provisioner: provisioner!,
      metadataDatabaseUrl: metadataDatabaseUrl!,
      consentPublicKey,
    },
  };
}
