import {
  WebAuthnAbortService,
  WebAuthnError,
  startAuthentication as webauthnStartAuthentication,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/browser';
import { PASSKEY_CHALLENGE_EXPIRY_MINUTES } from '@pagespace/lib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyResponseData = {
  redirectUrl?: string;
  redirectTo?: string;
  sessionToken?: string;
  csrfToken?: string;
  deviceToken?: string;
};

export type CeremonyResult =
  | { status: 'success'; data: VerifyResponseData }
  | { status: 'retry'; reason: 'refresh-timer' | 'challenge-expired' }
  | { status: 'abort'; reason: 'unmount' | 'options-failed' | 'ceremony-error' }
  | { status: 'failure'; message: string };

export type CeremonyState = 'idle' | 'running' | 'done';

type PlatformFields = Record<string, unknown>;

type AuthOptions = { challenge: string } & Record<string, unknown>;

export type CeremonyDeps = {
  csrfToken: string;
  refreshIntervalMs: number;
  refreshToken?: () => Promise<string | null>;
  getDevicePlatformFields: () => Promise<PlatformFields>;
  isMounted: () => boolean;
  fetchFn?: typeof fetch;
  startAuthentication?: typeof webauthnStartAuthentication;
  cancelCeremony?: () => void;
};

type CeremonyContext = Required<Omit<CeremonyDeps, 'refreshToken'>> &
  Pick<CeremonyDeps, 'refreshToken'> & {
    authOptions?: AuthOptions;
    platformFields?: PlatformFields;
    authResponse?: AuthenticationResponseJSON;
    verifyCsrfToken?: string;
  };

type StepOut = CeremonyContext | CeremonyResult;
type Step = (ctx: CeremonyContext) => Promise<StepOut>;

// ---------------------------------------------------------------------------
// Pure predicates and classifiers
// ---------------------------------------------------------------------------

const SAFETY_BUFFER_MINUTES = 1;

export const deriveRefreshIntervalMs = ({
  ttlMinutes = PASSKEY_CHALLENGE_EXPIRY_MINUTES,
  bufferMinutes = SAFETY_BUFFER_MINUTES,
}: { ttlMinutes?: number; bufferMinutes?: number } = {}): number =>
  Math.max(ttlMinutes - bufferMinutes, 1) * 60 * 1000;

export const isCeremonyAborted = ({ err }: { err?: unknown } = {}): boolean =>
  err instanceof WebAuthnError && err.code === 'ERROR_CEREMONY_ABORTED';

export const isChallengeExpired = ({ code }: { code?: string } = {}): boolean =>
  code === 'CHALLENGE_EXPIRED';

export const isUnmountAbort = ({
  err,
  mounted,
}: { err?: unknown; mounted?: boolean } = {}): boolean =>
  isCeremonyAborted({ err }) && mounted === false;

export const isRefreshAbort = ({
  err,
  mounted,
}: { err?: unknown; mounted?: boolean } = {}): boolean =>
  isCeremonyAborted({ err }) && mounted === true;

export const classifyVerifyResponse = ({
  ok,
  code,
  data,
  message,
}: {
  ok: boolean;
  code?: string;
  data?: VerifyResponseData;
  message?: string;
}): CeremonyResult => {
  if (ok && data) return { status: 'success', data };
  if (isChallengeExpired({ code })) return { status: 'retry', reason: 'challenge-expired' };
  return { status: 'failure', message: message ?? 'Authentication failed' };
};

export const classifyCeremonyError = ({
  err,
  mounted,
}: {
  err: unknown;
  mounted: boolean;
}): CeremonyResult => {
  if (isUnmountAbort({ err, mounted })) return { status: 'abort', reason: 'unmount' };
  if (isRefreshAbort({ err, mounted })) return { status: 'retry', reason: 'refresh-timer' };
  return { status: 'abort', reason: 'ceremony-error' };
};

export const nextState = ({
  state = 'idle',
  result,
}: {
  state?: CeremonyState;
  result?: CeremonyResult;
} = {}): CeremonyState => {
  if (state === 'idle') return 'running';
  if (state === 'running' && result?.status === 'retry') return 'running';
  return 'done';
};

// ---------------------------------------------------------------------------
// AsyncPipe with terminal short-circuit
// ---------------------------------------------------------------------------

const isTerminal = (out: StepOut): out is CeremonyResult =>
  out != null && typeof out === 'object' && 'status' in out;

const asyncPipe =
  (...fns: Step[]) =>
  async (ctx: CeremonyContext): Promise<StepOut> => {
    let acc: StepOut = ctx;
    for (const fn of fns) {
      if (isTerminal(acc)) return acc;
      acc = await fn(acc);
    }
    return acc;
  };

// ---------------------------------------------------------------------------
// Pipe steps (impure, but composed from pure classifiers)
// ---------------------------------------------------------------------------

const fetchAuthenticationOptions: Step = async (ctx) => {
  const platformFields = await ctx.getDevicePlatformFields();

  const res = await ctx.fetchFn('/api/auth/passkey/authenticate/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken: ctx.csrfToken }),
  });
  if (!res.ok || !ctx.isMounted()) {
    return { status: 'abort', reason: 'options-failed' };
  }

  const { options } = (await res.json()) as { options: AuthOptions };
  return { ...ctx, platformFields, authOptions: options };
};

const startAssertionWithRefreshTimer: Step = async (ctx) => {
  if (!ctx.authOptions) return { status: 'abort', reason: 'ceremony-error' };

  let refreshTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    if (ctx.isMounted()) ctx.cancelCeremony();
  }, ctx.refreshIntervalMs);

  try {
    const authResponse = await ctx.startAuthentication({
      optionsJSON: ctx.authOptions,
      useBrowserAutofill: true,
    });
    if (!ctx.isMounted()) return { status: 'abort', reason: 'unmount' };
    return { ...ctx, authResponse };
  } catch (err) {
    return classifyCeremonyError({ err, mounted: ctx.isMounted() });
  } finally {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
};

const refreshCsrfToken: Step = async (ctx) => {
  const fresh = ctx.refreshToken ? await ctx.refreshToken() : null;
  return { ...ctx, verifyCsrfToken: fresh ?? ctx.csrfToken };
};

const verifyAssertion: Step = async (ctx) => {
  const res = await ctx.fetchFn('/api/auth/passkey/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response: ctx.authResponse,
      expectedChallenge: ctx.authOptions?.challenge,
      csrfToken: ctx.verifyCsrfToken,
      ...(ctx.platformFields ?? {}),
    }),
  });
  if (!ctx.isMounted()) return { status: 'abort', reason: 'unmount' };

  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    return classifyVerifyResponse({
      ok: false,
      code: error.code,
      message: error.error,
    });
  }

  const data = (await res.json()) as VerifyResponseData;
  return classifyVerifyResponse({ ok: true, data });
};

// ---------------------------------------------------------------------------
// Composed ceremony runner
// ---------------------------------------------------------------------------

export const runCeremony = async (deps: CeremonyDeps): Promise<CeremonyResult> => {
  const ctx: CeremonyContext = {
    csrfToken: deps.csrfToken,
    refreshIntervalMs: deps.refreshIntervalMs,
    refreshToken: deps.refreshToken,
    getDevicePlatformFields: deps.getDevicePlatformFields,
    isMounted: deps.isMounted,
    fetchFn: deps.fetchFn ?? fetch,
    startAuthentication: deps.startAuthentication ?? webauthnStartAuthentication,
    cancelCeremony: deps.cancelCeremony ?? (() => WebAuthnAbortService.cancelCeremony()),
  };

  const pipe = asyncPipe(
    fetchAuthenticationOptions,
    startAssertionWithRefreshTimer,
    refreshCsrfToken,
    verifyAssertion,
  );

  const out = await pipe(ctx);
  return isTerminal(out) ? out : { status: 'abort', reason: 'ceremony-error' };
};

// ---------------------------------------------------------------------------
// Loop driver
// ---------------------------------------------------------------------------

export const driveCeremony = async ({
  runOnce,
  isMounted,
}: {
  runOnce: () => Promise<CeremonyResult>;
  isMounted: () => boolean;
}): Promise<CeremonyResult | undefined> => {
  let state: CeremonyState = 'idle';
  let result: CeremonyResult | undefined;
  while (isMounted() && nextState({ state, result }) === 'running') {
    state = 'running';
    result = await runOnce();
  }
  return result;
};

// ---------------------------------------------------------------------------
// Result handler (side effects)
// ---------------------------------------------------------------------------

export const handleCeremonyResult = async ({
  result,
  onAuthenticated,
  onRedirect,
  onFailure,
  handleDesktopAuthResponse,
}: {
  result?: CeremonyResult;
  onAuthenticated?: () => void;
  onRedirect: (redirectUrl: string) => void;
  onFailure: (message: string) => void;
  handleDesktopAuthResponse: (data: VerifyResponseData) => Promise<boolean>;
}): Promise<void> => {
  if (!result) return;
  if (result.status === 'abort' || result.status === 'retry') return;
  if (result.status === 'failure') {
    onFailure(result.message);
    return;
  }
  onAuthenticated?.();
  if (await handleDesktopAuthResponse(result.data)) return;
  const redirectUrl = result.data.redirectUrl ?? result.data.redirectTo ?? '/dashboard';
  onRedirect(redirectUrl);
};
