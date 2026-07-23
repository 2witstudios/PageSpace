/**
 * One entry point for "get a human to approve this scope", over either
 * transport: the loopback+PKCE browser flow (`runLoopbackLogin`) or the RFC
 * 8628 device flow (`runDeviceLogin`).
 *
 * Every consent-driven command — `login`, `keys create`, `keys use`, and the
 * wizard's mint/edit/activate steps — needs the same `--device` choice, and
 * each one previously hard-wired the loopback flow plus its own eight-case
 * outcome switch. Adding a second transport per command would have meant four
 * more copies of that switch, each free to drift on which failures are fatal
 * or what remediation they name. Instead the transports are normalized here
 * into one small result type, and the per-command copy is reduced to the retry
 * hint each one wants to print.
 *
 * The two flows differ in what can go wrong (a browser flow can fail to bind a
 * loopback port; a device flow can have its code expire before approval), so
 * `describeConsentFailure` renders each transport's failure modes in its own
 * words rather than flattening them to a generic "consent failed".
 */
import type { CredentialStore } from '../credentials/store.js';
import { runDeviceLogin } from './device-flow.js';
import type { DeviceAuthorization, PollDeviceToken, RequestDeviceAuthorization } from './device-flow.js';
import { runLoopbackLogin } from './loopback-flow.js';
import type {
  ConfirmIdentity,
  DiscoverMetadata,
  ExchangeCode,
  Identity,
  OpenBrowser,
  RandomBytes,
  StartLoopbackServer,
  WaitMs,
} from './loopback-flow.js';

/** Effects only the browser transport needs. */
export interface LoopbackConsentDeps {
  readonly randomBytes: RandomBytes;
  readonly startServer: StartLoopbackServer;
  readonly openBrowser: OpenBrowser;
  readonly maxPortAttempts: number;
  readonly onBrowserOpenFailed: (url: string) => void;
}

/** Effects only the device transport needs. */
export interface DeviceConsentDeps {
  readonly requestDeviceAuthorization: RequestDeviceAuthorization;
  readonly pollDeviceToken: PollDeviceToken;
  readonly isInterrupted: () => boolean;
  readonly onDeviceCode: (authorization: DeviceAuthorization) => void;
  /**
   * The device transport's OWN delay adapter, deliberately separate from
   * `RunConsentParams.waitMs`.
   *
   * The two transports need opposite timer semantics and must never share one
   * adapter. Loopback consent races its 5-minute timeout against the callback
   * and needs `unrefWaitMs`, or the losing timer pins the event loop and hangs
   * the CLI at exit. Device polling is a sequential loop where the delay
   * between polls is often the ONLY live handle, so it needs the REF'd
   * `waitMs` — an unref'd one lets Node exit right after printing the
   * verification code, before the user has any chance to approve. See
   * `auth/wait.ts`.
   *
   * Keeping it here rather than at the top level means each transport carries
   * the timer it actually needs, so a command wiring `unrefWaitMs` for its
   * loopback path cannot silently impose it on the device path too.
   */
  readonly waitMs: WaitMs;
}

export interface RunConsentParams {
  /** True when `--device` was passed: no browser is opened, a code is printed instead. */
  readonly device: boolean;
  readonly host: string;
  readonly clientId: string;
  readonly scope: string;
  readonly discoverMetadata: DiscoverMetadata;
  readonly exchangeCode: ExchangeCode;
  readonly confirmIdentity: ConfirmIdentity;
  readonly credentialStore: Pick<CredentialStore, 'set'>;
  /** The LOOPBACK transport's delay adapter; the device transport carries its own (`DeviceConsentDeps.waitMs`). */
  readonly waitMs: WaitMs;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly profile?: string;
  readonly onMintedStaticToken?: (token: string) => void;
  readonly loopback: LoopbackConsentDeps;
  readonly deviceDeps: DeviceConsentDeps;
}

export type ConsentResult =
  | {
      readonly outcome: 'success';
      readonly identity: Identity | null;
      readonly scope: string;
      readonly updatedTokenId?: string;
      readonly activatedTokenId?: string;
    }
  | { readonly outcome: 'failed'; readonly message: string };

/**
 * Renders a transport-specific failure into one actionable line. `retryCommand`
 * is the exact command the user should run again (e.g. `pagespace keys create
 * --device`), so the remediation always matches what they actually typed.
 */
export function describeConsentFailure(
  result: Awaited<ReturnType<typeof runLoopbackLogin>> | Awaited<ReturnType<typeof runDeviceLogin>>,
  retryCommand: string,
  host: string,
): string {
  switch (result.outcome) {
    case 'success':
      throw new Error('describeConsentFailure called on a successful consent');
    // Shared by both transports.
    case 'timeout':
      return `Timed out waiting for approval. Run "${retryCommand}" again.`;
    case 'access_denied':
      return 'Access was denied.';
    case 'discovery_failed':
      return `Could not discover the OAuth server configuration for ${host}: ${result.message}`;
    // Loopback only.
    case 'state_mismatch':
      return `The authorization response did not match this request. Run "${retryCommand}" again.`;
    case 'authorize_error':
      return `Consent failed: ${result.error}`;
    case 'token_exchange_failed':
      return `Consent failed while exchanging the authorization code: ${result.message}`;
    case 'port_bind_failed':
      return `Could not bind a local loopback port to receive the redirect. On a machine with no browser, run "${retryCommand} --device" instead.`;
    // Device only.
    case 'expired_token':
      return `The device code expired before approval completed. Run "${retryCommand}" again.`;
    case 'poll_failed':
      return `Failed while polling for approval: ${result.message}`;
    case 'interrupted':
      return 'Cancelled.';
    case 'device_authorization_failed':
      return `Could not start device approval: ${result.message}`;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled consent outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}

export async function runConsent(params: RunConsentParams, retryCommand: string): Promise<ConsentResult> {
  const shared = {
    host: params.host,
    clientId: params.clientId,
    scope: params.scope,
    discoverMetadata: params.discoverMetadata,
    confirmIdentity: params.confirmIdentity,
    credentialStore: params.credentialStore,
    now: params.now,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
    onMintedStaticToken: params.onMintedStaticToken,
  };

  const result = params.device
    ? await runDeviceLogin({
        ...shared,
        // The ref'd adapter — never `params.waitMs`. See DeviceConsentDeps.waitMs.
        waitMs: params.deviceDeps.waitMs,
        requestDeviceAuthorization: params.deviceDeps.requestDeviceAuthorization,
        pollDeviceToken: params.deviceDeps.pollDeviceToken,
        isInterrupted: params.deviceDeps.isInterrupted,
        onDeviceCode: params.deviceDeps.onDeviceCode,
      })
    : await runLoopbackLogin({
        ...shared,
        waitMs: params.waitMs,
        exchangeCode: params.exchangeCode,
        randomBytes: params.loopback.randomBytes,
        startServer: params.loopback.startServer,
        openBrowser: params.loopback.openBrowser,
        maxPortAttempts: params.loopback.maxPortAttempts,
        onBrowserOpenFailed: params.loopback.onBrowserOpenFailed,
      });

  if (result.outcome === 'success') {
    return {
      outcome: 'success',
      identity: result.identity,
      scope: result.scope,
      updatedTokenId: result.updatedTokenId,
      activatedTokenId: result.activatedTokenId,
    };
  }

  return { outcome: 'failed', message: describeConsentFailure(result, retryCommand, params.host) };
}

/** The verification lines a device flow prints in place of opening a browser. */
export function renderDeviceCodePrompt(authorization: DeviceAuthorization): string[] {
  return [
    'To approve this on any device with a browser, visit:',
    `  ${authorization.verificationUri}`,
    `And enter this code: ${authorization.userCode}`,
    `Or open directly: ${authorization.verificationUriComplete}`,
  ];
}
