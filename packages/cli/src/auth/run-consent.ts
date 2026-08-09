/**
 * One entry point for "get a human to approve this scope", over either
 * transport: the loopback+PKCE browser flow (`runLoopbackLogin`) or the RFC
 * 8628 device flow (`runDeviceLogin`).
 *
 * Every key ceremony — `keys create`, `keys use`, and the wizard's
 * mint/edit/activate steps — needs the same `--device` choice, and each one
 * previously hard-wired the loopback flow plus its own eight-case outcome
 * switch. Adding a second transport per command would have meant three more
 * copies of that switch, each free to drift on which failures are fatal or
 * what remediation they name. Instead the transports are normalized here into
 * one small result type, and the per-command copy is reduced to the retry hint
 * each one wants to print.
 *
 * `login` / `login --device` deliberately do NOT route through here yet: they
 * are two separate handlers selected by `run.ts`, predating this seam, and
 * each still carries its own outcome switch. Folding them in means collapsing
 * `login-device.ts` into `login.ts`, which is a bigger change than this PR's
 * scope — but it is the obvious follow-up, and until it happens this module is
 * the seam for the KEY ceremonies only.
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
  /**
   * Creates the interrupt flag. A FACTORY, not a flag: it installs a
   * `process.once('SIGINT')` listener, and registering one replaces Node's
   * default terminate-on-Ctrl-C — so it must run only when a device flow is
   * actually starting, never at a command module's top level where every
   * `pagespace` invocation would pay for it. `runConsent` calls it inside the
   * device branch alone.
   */
  readonly createIsInterrupted: () => () => boolean;
  readonly onDeviceCode: (authorization: DeviceAuthorization) => void;
  /**
   * The REF'd delay adapter. Device polling is a sequential loop where the
   * delay between polls is often the only live handle, so an unref'd timer
   * lets Node exit right after printing the verification code, before the user
   * can approve. Named per-transport (vs `loopbackWaitMs`) so the two can
   * never be handed the same adapter by omission. See `auth/wait.ts`.
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
  /**
   * The UNREF'd delay adapter, for the loopback flow's timeout race. Ref'ing it
   * would pin the event loop after a successful login; the device transport
   * needs the opposite and carries its own (`DeviceConsentDeps.waitMs`).
   */
  readonly loopbackWaitMs: WaitMs;
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
        waitMs: params.deviceDeps.waitMs,
        requestDeviceAuthorization: params.deviceDeps.requestDeviceAuthorization,
        pollDeviceToken: params.deviceDeps.pollDeviceToken,
        // Installed here, and only here: the SIGINT listener must not exist
        // for invocations that never reach a device flow.
        isInterrupted: params.deviceDeps.createIsInterrupted(),
        onDeviceCode: params.deviceDeps.onDeviceCode,
      })
    : await runLoopbackLogin({
        ...shared,
        waitMs: params.loopbackWaitMs,
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
