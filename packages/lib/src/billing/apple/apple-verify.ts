/**
 * apple-verify — the imperative shell around Apple's official
 * @apple/app-store-server-library SignedDataVerifier. It turns a signed JWS (a StoreKit 2
 * transaction posted by the device, or an App Store Server Notification V2 posted by
 * Apple) into a verified decoded payload, or throws AppleVerificationError. Nothing
 * downstream ever reads an unverified field: the planner (apple-core) only sees what this
 * module returns.
 *
 * Trust: only the embedded Apple Root CA - G3 (apple-root-certs). With online checks on
 * (the default) the library also checks the chain's OCSP revocation status and dates
 * against the current clock. Two verifiers exist — Production and Sandbox — because the
 * library pins one environment per verifier; the payload's own (unverified) environment
 * claim only picks which one runs, and that verifier then refuses any payload whose
 * signed environment differs. Xcode / LocalTesting payloads are never verified (the
 * library would skip the signature check for them), they are refused outright.
 */

import { Environment, SignedDataVerifier, VerificationException } from '@apple/app-store-server-library';
import { appleRootCertificates } from './apple-root-certs';
import type { DecodedTransactionLike } from './apple-core';

export const DEFAULT_APPLE_BUNDLE_ID = 'ai.pagespace.ios';

export interface AppleVerifierConfig {
  bundleId: string;
  /** The app's numeric Apple ID — required to verify Production payloads. */
  appAppleId: number | undefined;
  /** Whether Sandbox purchases may fund this deployment (App Review and TestFlight buy in Sandbox). */
  allowSandbox: boolean;
  /** OCSP revocation + current-date checks. Off only in tests with a synthetic chain. */
  enableOnlineChecks: boolean;
  rootCertificates: Buffer[];
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Read the verifier configuration from the environment:
 *   APPLE_IAP_BUNDLE_ID      default ai.pagespace.ios
 *   APPLE_IAP_APP_APPLE_ID   the numeric App Apple ID (App Store Connect › App Information)
 *   APPLE_IAP_ALLOW_SANDBOX  default true — App Review purchases in Sandbox against the
 *                            production build, so turning it off fails review
 *   APPLE_IAP_ONLINE_CHECKS  default true
 */
export function appleVerifierConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppleVerifierConfig {
  const rawAppId = env.APPLE_IAP_APP_APPLE_ID?.trim();
  const appAppleId = rawAppId && /^\d+$/.test(rawAppId) ? Number(rawAppId) : undefined;
  return {
    bundleId: env.APPLE_IAP_BUNDLE_ID?.trim() || DEFAULT_APPLE_BUNDLE_ID,
    appAppleId,
    allowSandbox: envFlag(env.APPLE_IAP_ALLOW_SANDBOX, true),
    enableOnlineChecks: envFlag(env.APPLE_IAP_ONLINE_CHECKS, true),
    rootCertificates: appleRootCertificates(),
  };
}

export type AppleVerificationFailure =
  /** The signature, chain, bundle or environment did not verify. */
  | 'invalid_signature'
  /** The payload is not a JWS, or names no environment we verify. */
  | 'malformed'
  /** Production verification is not configured (APPLE_IAP_APP_APPLE_ID missing). */
  | 'not_configured'
  /** A transient failure (e.g. OCSP unreachable) — the caller should let the sender retry. */
  | 'retryable';

export class AppleVerificationError extends Error {
  constructor(public readonly failure: AppleVerificationFailure, message: string) {
    super(message);
    this.name = 'AppleVerificationError';
  }
}

/** The verified renewal facts a notification carries. */
export interface VerifiedRenewalInfo {
  autoRenew: boolean;
  gracePeriodExpiresMs: number | null;
}

/** A verified App Store Server Notification V2. */
export interface VerifiedNotification {
  notificationUUID: string;
  type: string;
  subtype: string | null;
  /** App Store subscription status code (1 active … 5 revoked), when sent. */
  status: number | null;
  transaction: DecodedTransactionLike | null;
  renewal: VerifiedRenewalInfo | null;
}

export interface AppleVerifier {
  verifyTransaction(signedTransaction: string): Promise<DecodedTransactionLike>;
  verifyNotification(signedPayload: string): Promise<VerifiedNotification>;
}

/** Read a JWS payload claim WITHOUT verifying it — only to choose which verifier runs. */
function unverifiedEnvironment(jws: string, pick: (payload: Record<string, unknown>) => unknown): Environment {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new AppleVerificationError('malformed', 'not a compact JWS');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new AppleVerificationError('malformed', 'JWS payload is not JSON');
  }
  if (typeof payload !== 'object' || payload === null) throw new AppleVerificationError('malformed', 'JWS payload is not an object');
  const env = pick(payload as Record<string, unknown>);
  if (env === Environment.PRODUCTION) return Environment.PRODUCTION;
  if (env === Environment.SANDBOX) return Environment.SANDBOX;
  throw new AppleVerificationError('malformed', 'payload names no App Store environment we verify');
}

const RETRYABLE_STATUS = 2; // VerificationStatus.RETRYABLE_VERIFICATION_FAILURE

function asVerificationError(error: unknown): AppleVerificationError {
  if (error instanceof AppleVerificationError) return error;
  if (error instanceof VerificationException) {
    return error.status === RETRYABLE_STATUS
      ? new AppleVerificationError('retryable', 'App Store signature check could not complete')
      : new AppleVerificationError('invalid_signature', `App Store signature did not verify (status ${error.status})`);
  }
  return new AppleVerificationError('invalid_signature', error instanceof Error ? error.message : 'verification failed');
}

export function createAppleVerifier(config: AppleVerifierConfig): AppleVerifier {
  const verifiers = new Map<Environment, SignedDataVerifier>();
  const verifierFor = (environment: Environment): SignedDataVerifier => {
    const cached = verifiers.get(environment);
    if (cached) return cached;
    if (environment === Environment.PRODUCTION && config.appAppleId === undefined) {
      throw new AppleVerificationError('not_configured', 'APPLE_IAP_APP_APPLE_ID is required to verify Production purchases');
    }
    const verifier = new SignedDataVerifier(
      config.rootCertificates,
      config.enableOnlineChecks,
      environment,
      config.bundleId,
      environment === Environment.PRODUCTION ? config.appAppleId : undefined,
    );
    verifiers.set(environment, verifier);
    return verifier;
  };

  return {
    async verifyTransaction(signedTransaction) {
      try {
        const environment = unverifiedEnvironment(signedTransaction, (p) => p.environment);
        const decoded = await verifierFor(environment).verifyAndDecodeTransaction(signedTransaction);
        return decoded as DecodedTransactionLike;
      } catch (error) {
        throw asVerificationError(error);
      }
    },

    async verifyNotification(signedPayload) {
      try {
        const environment = unverifiedEnvironment(signedPayload, (p) => {
          const data = p.data as Record<string, unknown> | undefined;
          const summary = p.summary as Record<string, unknown> | undefined;
          return data?.environment ?? summary?.environment;
        });
        const verifier = verifierFor(environment);
        const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
        if (!decoded.notificationUUID || !decoded.notificationType) {
          throw new AppleVerificationError('malformed', 'notification has no id or type');
        }
        const data = decoded.data;
        const transaction = data?.signedTransactionInfo
          ? ((await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo)) as DecodedTransactionLike)
          : null;
        const renewalInfo = data?.signedRenewalInfo ? await verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo) : null;
        return {
          notificationUUID: decoded.notificationUUID,
          type: String(decoded.notificationType),
          subtype: decoded.subtype ? String(decoded.subtype) : null,
          status: typeof data?.status === 'number' ? data.status : null,
          transaction,
          renewal: renewalInfo
            ? {
                autoRenew: renewalInfo.autoRenewStatus !== 0,
                gracePeriodExpiresMs: typeof renewalInfo.gracePeriodExpiresDate === 'number' ? renewalInfo.gracePeriodExpiresDate : null,
              }
            : null,
        };
      } catch (error) {
        throw asVerificationError(error);
      }
    },
  };
}

let defaultVerifier: { config: AppleVerifierConfig; verifier: AppleVerifier } | null = null;

/** The process-wide verifier, configured from the environment on first use. */
export function getAppleVerifier(): { config: AppleVerifierConfig; verifier: AppleVerifier } {
  if (!defaultVerifier) {
    const config = appleVerifierConfigFromEnv();
    defaultVerifier = { config, verifier: createAppleVerifier(config) };
  }
  return defaultVerifier;
}
