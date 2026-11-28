/**
 * An AI agent's OWN PageSpace account, from the terminal (ADR 0008; Agent
 * Signup Phase 5). Not the `agents` verbs, which drive AI agent PAGES inside a
 * drive — these commands are about the caller's identity itself:
 *
 *   pagespace signup --agent [--name <n>] [--source <s>] [--show-secret]
 *       challenge → solve the proof-of-work → register → exchange the secret →
 *       store the agent credential → mint the agent's own access key and make
 *       it this machine's active key. Afterwards `pagespace drives list` and
 *       `pagespace mcp` work as the agent with no further step.
 *   pagespace login --agent          the same, for an agent that already has a
 *                                    secret (read from stdin or a prompt, never argv)
 *   pagespace agent claim            a user code a human approves; poll until claimed
 *   pagespace agent rotate-secret    a new secret (old one dies immediately)
 *   pagespace agent create-key       mint (another) access key for this agent
 *
 * Where things live: the agent credential (`kind: 'agent'`: the durable
 * secret, a refresh token, the claim token) under the login slot (`default`,
 * or `--key <name>`); the agent's `mcp_` key as a `static` credential under
 * `agent`, which is also set as the host's active key. The secret is printed
 * only with `--show-secret`, and only on the call that created it.
 *
 * Auth path: these handlers are auth-exempt in `run.ts`. Unauthenticated
 * steps go through `ctx.sdk` (the SDK sends no credential for them);
 * authenticated steps on an existing agent credential go through `ctx.sdk`
 * too, which `run.ts` built from that credential (`auth/auth-context.ts`
 * refreshes it, re-exchanging the secret on invalid_grant). Calls made with a
 * token this command just obtained use the `auth/` helpers. No command module
 * constructs its own client (`single-auth-path.test.ts`).
 */
import {
  exchangeAgentAssertion,
  isInvalidGrantError,
  isPermissionDeniedError,
  isRateLimitError,
  isValidationError,
  PAGESPACE_AGENT_CLIENT_ID,
} from '@pagespace/sdk';
import type { OAuthTokens } from '@pagespace/sdk';
import { AGENT_CONTENT_KEY_LABEL, AGENT_CONTENT_KEY_NAME, AGENT_CONTENT_KEY_SCOPES, mintAgentKey, mintAgentKeyOperation } from '../auth/agent-key.js';
import type { MintAgentKey, MintedAgentKey } from '../auth/agent-key.js';
import { fetchAccountProfile } from '../auth/agent-profile.js';
import type { FetchAccountProfile } from '../auth/agent-profile.js';
import { isAgentSecretShape, solveAgentPow } from '../auth/agent-pow.js';
import { agentCredentialWithTokens } from '../auth/agent-session.js';
import { createDiscoverMetadata } from '../auth/discover.js';
import { resolveEnvKeyName } from '../auth/legacy-token-env.js';
import { createPollAgentClaim } from '../auth/poll-agent-claim.js';
import type { PollAgentClaim } from '../auth/poll-agent-claim.js';
import { readSecret } from '../auth/read-secret.js';
import type { ReadSecret } from '../auth/read-secret.js';
import { resolveKeyName } from '../auth/resolve.js';
import { createSigintFlag } from '../auth/sigint.js';
import { waitMs } from '../auth/wait.js';
import type { WaitMs } from '../auth/loopback-flow.js';
import { resolveConfig } from '../config/resolve.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import type { AgentHostCredential } from '../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { ExitCode } from '../exit-codes.js';
import { formatCliError } from '../format-error.js';
import type { CommandIntent } from '../argv/parse.js';
import type { HandlerContext } from '../handler-context.js';
import type { CommandHandler } from '../router/router.js';
import { shellQuote } from '../shell-quote.js';
import { parseAgentArgs } from './agent-args.js';
import type { AgentArgs, AgentArgsSpec } from './agent-args.js';

/** Signing up accepts these (auth.md: `tos_accepted: true`); said out loud on every signup. */
export const PAGESPACE_TERMS_URL = 'https://pagespace.ai/terms';

/** Shown as the agent's `source` when the agent names none. Display only. */
export const DEFAULT_AGENT_SOURCE = 'pagespace-cli';

export interface AgentCommandDeps {
  readonly discoverTokenEndpoint: (host: string) => Promise<{ readonly tokenEndpoint: string }>;
  readonly exchange: (tokenEndpoint: string, secret: string, clientId: string) => Promise<OAuthTokens>;
  readonly solvePow: (challenge: string, difficultyBits: number) => string;
  readonly mintKey: MintAgentKey;
  readonly fetchProfile: FetchAccountProfile;
  readonly pollClaim: PollAgentClaim;
  readonly readSecret: ReadSecret;
  readonly waitMs: WaitMs;
  readonly now: () => number;
  /** A factory: installing a SIGINT listener replaces Node's Ctrl-C, so only a poll that is starting may do it. */
  readonly createIsInterrupted: () => () => boolean;
}

function hostOf(ctx: HandlerContext, intent: CommandIntent): string {
  return resolveConfig({ flags: { host: intent.flags.host }, env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL }, credential: null }).host;
}

function loginProfileOf(ctx: HandlerContext, intent: CommandIntent): string {
  return resolveKeyName({ key: intent.flags.key }, { PAGESPACE_KEY: resolveEnvKeyName(ctx.env).name });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseOrUsage(ctx: HandlerContext, intent: CommandIntent, spec: AgentArgsSpec): AgentArgs | null {
  const parsed = parseAgentArgs(intent.args, spec);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return null;
  }
  return parsed.args;
}

/** Refuses to overwrite a stored login (or a key stored under the agent key's name) unless `--yes`. */
async function refuseExisting(ctx: HandlerContext, intent: CommandIntent, host: string, profile: string): Promise<boolean> {
  if (intent.flags.yes) return false;
  const login = await ctx.credentialStore.get(host, profile);
  const key = profile === AGENT_CONTENT_KEY_NAME ? null : await ctx.credentialStore.get(host, AGENT_CONTENT_KEY_NAME);
  if (login === null && key === null) return false;
  const what = login !== null ? (profile === DEFAULT_PROFILE_NAME ? 'a login' : `a credential named "${profile}"`) : `a key named "${AGENT_CONTENT_KEY_NAME}"`;
  ctx.stderr.write(
    `${host} already has ${what} stored on this machine. Re-run with --yes to replace it` +
      (login?.kind === 'agent' ? ' (the stored agent secret is overwritten — keep a copy if you still need that agent)' : '') +
      `, or use another slot with --key=<name>, or "pagespace logout --host=${shellQuote(host)}" first.\n`,
  );
  return true;
}

function describeFailure(error: unknown): string {
  if (isRateLimitError(error)) {
    const seconds = error.retryAfterMs === null ? null : Math.ceil(error.retryAfterMs / 1000);
    return `rate limited${seconds === null ? '' : `; retry in ${seconds}s`}`;
  }
  return formatCliError(error);
}

interface KeyProvisioning {
  readonly key: MintedAgentKey | null;
  readonly activated: boolean;
  readonly failure: string | null;
}

/**
 * Mints the agent's own access key with `accessToken`, stores it under
 * `agent`, records that on the agent credential, and makes it the host's
 * active key. Never fails the command: the account exists either way, and
 * `pagespace agent create-key` retries just this step.
 */
async function provisionAgentKey(
  ctx: HandlerContext,
  deps: AgentCommandDeps,
  host: string,
  profile: string,
  credential: AgentHostCredential,
  mint: () => Promise<MintedAgentKey>,
): Promise<KeyProvisioning> {
  let key: MintedAgentKey;
  try {
    key = await mint();
  } catch (error) {
    return { key: null, activated: false, failure: describeFailure(error) };
  }

  await ctx.credentialStore.set(
    host,
    { kind: 'static', token: key.token, scopes: AGENT_CONTENT_KEY_SCOPES, createdAt: new Date(deps.now()).toISOString() },
    AGENT_CONTENT_KEY_NAME,
  );
  // Re-read: a refresh during the mint may have rotated the stored refresh token.
  const latest = await ctx.credentialStore.get(host, profile);
  const base = latest !== null && latest.kind === 'agent' ? latest : credential;
  await ctx.credentialStore.set(host, { ...base, contentKeyName: AGENT_CONTENT_KEY_NAME }, profile);

  try {
    await ctx.activeKeyStore.setActiveKey(host, AGENT_CONTENT_KEY_NAME);
    return { key, activated: true, failure: null };
  } catch (error) {
    return { key, activated: false, failure: `could not set the active key: ${messageOf(error)}` };
  }
}

function keyLines(host: string, provisioning: KeyProvisioning): string[] {
  if (provisioning.key === null) {
    return [
      `Could not mint this agent's access key (${provisioning.failure}). The account is fine; content commands need a key —`,
      '  run "pagespace agent create-key" to try again.',
    ];
  }
  if (!provisioning.activated) {
    return [
      `Access key stored as "${AGENT_CONTENT_KEY_NAME}", but ${provisioning.failure}.`,
      `  Pass --key=${AGENT_CONTENT_KEY_NAME} to content commands and to "pagespace mcp".`,
    ];
  }
  return [
    `Access key "${AGENT_CONTENT_KEY_NAME}" minted and set as this machine's active key for ${host}: content commands and`,
    '"pagespace mcp" now act as this agent, in every drive it can reach.',
  ];
}

const NEXT_STEPS = [
  'Next:',
  '  pagespace whoami          # who you are, and whether you are claimed',
  '  pagespace drives list     # your drives (a Home drive is created for you)',
  '  pagespace mcp             # serve PageSpace as MCP tools to your MCP client',
  '  pagespace agent claim     # get a human to claim you, so your AI usage is funded',
];

function claimLines(): string[] {
  return [
    'Unclaimed: agents get no free AI credits, so AI features answer "requires_funding" until a human claims you.',
    '  Run "pagespace agent claim" and give the human the link it prints; their plan then pays for your AI usage.',
  ];
}

// ─── signup --agent ──────────────────────────────────────────────────────────

const SIGNUP_SPEC: AgentArgsSpec = { booleans: ['--agent', '--show-secret'], values: ['--name', '--source'] };

export function createSignupHandler(deps: AgentCommandDeps): CommandHandler {
  return async (ctx, intent): Promise<ExitCode> => {
    const args = parseOrUsage(ctx, intent, SIGNUP_SPEC);
    if (args === null) return EXIT_USAGE_ERROR;
    const host = hostOf(ctx, intent);

    if (!args.agent) {
      ctx.stderr.write(
        `People sign up in the browser: ${host}/auth/signup\n` +
          'AI agents create their own account (no email, no human) with:\n' +
          '  pagespace signup --agent --name "<your name>"\n',
      );
      return EXIT_USAGE_ERROR;
    }

    const profile = loginProfileOf(ctx, intent);
    if (await refuseExisting(ctx, intent, host, profile)) return EXIT_RUNTIME_ERROR;

    if (!intent.flags.json) {
      ctx.stdout.write(`Creating an AI agent account on ${host}. By signing up you accept the PageSpace terms: ${PAGESPACE_TERMS_URL}\n`);
    }

    // Prove work → Register. One retry with a fresh challenge on pow_invalid
    // (auth.md: re-fetch and solve again); any other refusal is final.
    let registered;
    try {
      registered = await registerWithProofOfWork(ctx, deps, args);
    } catch (error) {
      ctx.stderr.write(`Could not create the agent account on ${host}: ${describeFailure(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // Persist the secret FIRST: it is shown once, and every later step can
    // fail. A credential with no refresh token yet is exchanged on first use.
    const createdAt = new Date(deps.now()).toISOString();
    const stored: AgentHostCredential = {
      kind: 'agent',
      agentId: registered.agent_id,
      secret: registered.identity_assertion,
      refreshToken: null,
      clientId: PAGESPACE_AGENT_CLIENT_ID,
      claimToken: registered.claim_token,
      contentKeyName: null,
      scopes: [],
      createdAt,
    };
    await ctx.credentialStore.set(host, stored, profile);

    let tokens: OAuthTokens;
    try {
      const { tokenEndpoint } = await deps.discoverTokenEndpoint(host);
      tokens = await deps.exchange(tokenEndpoint, stored.secret, stored.clientId);
    } catch (error) {
      writeSignupResult(ctx, intent, args, host, registered, null, `the first sign-in failed (${describeFailure(error)}); any later command retries it`);
      return EXIT_SUCCESS;
    }
    const signedIn = agentCredentialWithTokens(stored, tokens, deps.now());
    await ctx.credentialStore.set(host, signedIn, profile);

    const provisioning = await provisionAgentKey(ctx, deps, host, profile, signedIn, () =>
      deps.mintKey({ host, accessToken: tokens.accessToken, name: AGENT_CONTENT_KEY_LABEL }),
    );
    writeSignupResult(ctx, intent, args, host, registered, provisioning, null);
    return EXIT_SUCCESS;
  };
}

async function registerWithProofOfWork(ctx: HandlerContext, deps: AgentCommandDeps, args: AgentArgs) {
  for (let attempt = 0; ; attempt += 1) {
    const challenge = await ctx.sdk.agent.challenge({});
    const nonce = deps.solvePow(challenge.challenge, challenge.difficulty_bits);
    try {
      return await ctx.sdk.agent.signup({
        type: 'anonymous',
        ...(args.name === undefined ? {} : { name: args.name }),
        source: args.source ?? DEFAULT_AGENT_SOURCE,
        tos_accepted: true,
        pow: { challenge: challenge.challenge, nonce },
      });
    } catch (error) {
      if (attempt === 0 && isPermissionDeniedError(error) && error.message === 'pow_invalid') continue;
      throw error;
    }
  }
}

function writeSignupResult(
  ctx: HandlerContext,
  intent: CommandIntent,
  args: AgentArgs,
  host: string,
  registered: { readonly agent_id: string; readonly identity_assertion: string },
  provisioning: KeyProvisioning | null,
  signInFailure: string | null,
): void {
  if (intent.flags.json) {
    ctx.stdout.write(
      `${JSON.stringify({
        host,
        agentId: registered.agent_id,
        accountType: 'agent',
        claimed: false,
        signedIn: signInFailure === null,
        keyName: provisioning?.key ? AGENT_CONTENT_KEY_NAME : null,
        activeKey: provisioning?.activated ? AGENT_CONTENT_KEY_NAME : null,
        ...(args.showSecret ? { secret: registered.identity_assertion } : {}),
        claimCommand: 'pagespace agent claim',
      })}\n`,
    );
    return;
  }

  const lines = [`Agent account created: ${registered.agent_id}${args.name ? ` ("${args.name}")` : ''} on ${host}.`];
  if (signInFailure !== null) lines.push(`Stored on this machine, but ${signInFailure}.`);
  if (provisioning !== null) lines.push(...keyLines(host, provisioning));
  lines.push(...claimLines());
  lines.push(
    args.showSecret
      ? `Secret (shown once — store it securely; anyone holding it is this agent): ${registered.identity_assertion}`
      : 'Your secret is stored in this machine\'s credential store and was not printed (pass --show-secret to print it at signup,\n  or "pagespace agent rotate-secret --show-secret" to replace it with one you can copy).',
  );
  lines.push(...NEXT_STEPS);
  ctx.stdout.write(`${lines.join('\n')}\n`);
}

// ─── login --agent ───────────────────────────────────────────────────────────

const LOGIN_SPEC: AgentArgsSpec = { booleans: ['--agent'], values: [] };

export function createAgentLoginHandler(deps: AgentCommandDeps): CommandHandler {
  return async (ctx, intent): Promise<ExitCode> => {
    const args = parseOrUsage(ctx, intent, LOGIN_SPEC);
    if (args === null) return EXIT_USAGE_ERROR;
    if (intent.flags.device) {
      ctx.stderr.write('--agent and --device are different logins: an agent signs in with its secret, no browser or code.\n');
      return EXIT_USAGE_ERROR;
    }
    const host = hostOf(ctx, intent);
    const profile = loginProfileOf(ctx, intent);
    if (await refuseExisting(ctx, intent, host, profile)) return EXIT_RUNTIME_ERROR;

    const secret = await deps.readSecret({ isTTY: ctx.isTTY, prompt: ctx.prompt, label: 'Agent secret (ps_agent_…)' });
    if (secret === null) {
      ctx.stderr.write('No secret given. Pipe it on stdin — never as an argument: printf %s "$SECRET" | pagespace login --agent\n');
      return EXIT_USAGE_ERROR;
    }
    if (!isAgentSecretShape(secret)) {
      ctx.stderr.write('That is not an agent secret: it is "ps_agent_" followed by 32 lowercase letters and digits.\n');
      return EXIT_USAGE_ERROR;
    }

    let tokens: OAuthTokens;
    let agentId: string;
    try {
      const { tokenEndpoint } = await deps.discoverTokenEndpoint(host);
      tokens = await deps.exchange(tokenEndpoint, secret, PAGESPACE_AGENT_CLIENT_ID);
      const profileInfo = await deps.fetchProfile({ host, accessToken: tokens.accessToken });
      if (profileInfo.accountType !== 'agent') {
        ctx.stderr.write(`That secret signed in to ${host}, but not as an AI agent account. Nothing was stored.\n`);
        return EXIT_RUNTIME_ERROR;
      }
      agentId = profileInfo.id;
    } catch (error) {
      ctx.stderr.write(
        isInvalidGrantError(error)
          ? `${host} refused that secret: it may have been rotated, or the agent revoked. Nothing was stored.\n`
          : `Could not sign in to ${host}: ${describeFailure(error)}\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    const credential = agentCredentialWithTokens(
      {
        kind: 'agent',
        agentId,
        secret,
        refreshToken: null,
        clientId: PAGESPACE_AGENT_CLIENT_ID,
        // A login does not learn the claim token; `agent claim` asks for it.
        claimToken: null,
        contentKeyName: null,
        scopes: [],
        createdAt: new Date(deps.now()).toISOString(),
      },
      tokens,
      deps.now(),
    );
    await ctx.credentialStore.set(host, credential, profile);

    const provisioning = await provisionAgentKey(ctx, deps, host, profile, credential, () =>
      deps.mintKey({ host, accessToken: tokens.accessToken, name: AGENT_CONTENT_KEY_LABEL }),
    );

    if (intent.flags.json) {
      ctx.stdout.write(
        `${JSON.stringify({ host, agentId, accountType: 'agent', keyName: provisioning.key ? AGENT_CONTENT_KEY_NAME : null, activeKey: provisioning.activated ? AGENT_CONTENT_KEY_NAME : null })}\n`,
      );
      return EXIT_SUCCESS;
    }
    ctx.stdout.write([`Signed in to ${host} as agent ${agentId}.`, ...keyLines(host, provisioning), ...NEXT_STEPS].join('\n') + '\n');
    return EXIT_SUCCESS;
  };
}

// ─── shared: the stored agent credential ─────────────────────────────────────

async function storedAgent(ctx: HandlerContext, host: string, profile: string): Promise<AgentHostCredential | null> {
  const credential = await ctx.credentialStore.get(host, profile);
  if (credential !== null && credential.kind === 'agent') return credential;
  ctx.stderr.write(
    `No AI agent account is signed in on this machine for ${host}${profile === DEFAULT_PROFILE_NAME ? '' : ` (key "${profile}")`}. ` +
      'Create one with "pagespace signup --agent", or sign in with "pagespace login --agent".\n',
  );
  return null;
}

// ─── agent claim ─────────────────────────────────────────────────────────────

const CLAIM_SPEC: AgentArgsSpec = { booleans: ['--no-wait'], values: [] };
const SLOW_DOWN_STEP_SECONDS = 5;

export function createAgentClaimHandler(deps: AgentCommandDeps): CommandHandler {
  return async (ctx, intent): Promise<ExitCode> => {
    const args = parseOrUsage(ctx, intent, CLAIM_SPEC);
    if (args === null) return EXIT_USAGE_ERROR;
    const host = hostOf(ctx, intent);
    const profile = loginProfileOf(ctx, intent);
    const credential = await storedAgent(ctx, host, profile);
    if (credential === null) return EXIT_RUNTIME_ERROR;

    const claimToken =
      credential.claimToken ??
      (await deps.readSecret({ isTTY: ctx.isTTY, prompt: ctx.prompt, label: 'Claim token (ps_claim_…, from your signup)' }));
    if (claimToken === null) {
      ctx.stderr.write('This machine has no claim token for the agent (it signed in with "login --agent"). Pipe it on stdin: printf %s "$CLAIM_TOKEN" | pagespace agent claim\n');
      return EXIT_USAGE_ERROR;
    }

    let started;
    try {
      started = await ctx.sdk.agent.claim({ claim_token: claimToken });
    } catch (error) {
      ctx.stderr.write(
        isValidationError(error)
          ? 'The claim token was refused: this agent may already be claimed, or the token is not this agent\'s.\n'
          : `Could not start a claim on ${host}: ${describeFailure(error)}\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    if (intent.flags.json) {
      ctx.stdout.write(
        `${JSON.stringify({ event: 'claim_started', userCode: started.user_code, verificationUri: started.verification_uri, verificationUriComplete: started.verification_uri_complete, expiresIn: started.expires_in, interval: started.interval })}\n`,
      );
    } else {
      ctx.stdout.write(
        [
          'Ask a human to claim this agent. They open this link, sign in as themselves and approve:',
          `  ${started.verification_uri_complete}`,
          `Or at ${started.verification_uri} they enter the code: ${started.user_code}`,
          `Once they approve, they own this agent and pay for its AI usage. The code expires in ${Math.round(started.expires_in / 60)} minutes.`,
        ].join('\n') + '\n',
      );
    }
    if (args.noWait) return EXIT_SUCCESS;

    let tokenEndpoint: string;
    try {
      tokenEndpoint = (await deps.discoverTokenEndpoint(host)).tokenEndpoint;
    } catch (error) {
      ctx.stderr.write(`Could not discover ${host}'s token endpoint to wait for the claim: ${messageOf(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    if (!intent.flags.json) ctx.stdout.write('Waiting for approval (Ctrl-C to stop; the code stays valid)…\n');
    const isInterrupted = deps.createIsInterrupted();
    const deadline = deps.now() + started.expires_in * 1000;
    let intervalSeconds = Math.max(1, started.interval);

    for (;;) {
      await deps.waitMs(intervalSeconds * 1000);
      if (isInterrupted()) {
        ctx.stderr.write('Stopped waiting. The code stays valid until it expires; run "pagespace agent claim" again to start over.\n');
        return EXIT_RUNTIME_ERROR;
      }
      if (deps.now() > deadline) {
        ctx.stderr.write('The claim code expired before anyone approved it. Run "pagespace agent claim" again for a new one.\n');
        return EXIT_RUNTIME_ERROR;
      }

      const result = await deps.pollClaim({ tokenEndpoint, claimToken, clientId: credential.clientId });
      switch (result.kind) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          intervalSeconds += SLOW_DOWN_STEP_SECONDS;
          continue;
        case 'expired_token':
          ctx.stderr.write('The claim code expired before anyone approved it. Run "pagespace agent claim" again for a new one.\n');
          return EXIT_RUNTIME_ERROR;
        case 'access_denied':
          ctx.stderr.write('The human declined the claim. This agent stays unclaimed.\n');
          return EXIT_RUNTIME_ERROR;
        case 'invalid_grant':
          ctx.stderr.write('The claim was already redeemed or is no longer valid. Run "pagespace whoami" to see whether this agent has an owner.\n');
          return EXIT_RUNTIME_ERROR;
        case 'request_failed':
          ctx.stderr.write(`Polling the claim failed: ${result.message}\n`);
          return EXIT_RUNTIME_ERROR;
        case 'claimed': {
          // Persist before anything else: the claim token is spent, and the
          // approval may carry a fresh pair (the old tokens keep working too).
          const latest = await ctx.credentialStore.get(host, profile);
          const base = latest !== null && latest.kind === 'agent' ? latest : credential;
          const claimed = result.tokens ? agentCredentialWithTokens(base, result.tokens, deps.now()) : base;
          await ctx.credentialStore.set(host, { ...claimed, claimToken: null }, profile);

          const owner = result.owner;
          if (intent.flags.json) {
            ctx.stdout.write(`${JSON.stringify({ event: 'claimed', owner })}\n`);
          } else {
            ctx.stdout.write(
              `Claimed by ${owner ? `${owner.name ?? owner.id} (${owner.id})` : 'a human'}. Your AI usage now bills your owner's plan; your identity, drives and keys are unchanged.\n`,
            );
          }
          return EXIT_SUCCESS;
        }
        default: {
          const unreachable: never = result;
          throw new Error(`Unhandled claim poll result: ${JSON.stringify(unreachable)}`);
        }
      }
    }
  };
}

// ─── agent rotate-secret ─────────────────────────────────────────────────────

const ROTATE_SPEC: AgentArgsSpec = { booleans: ['--show-secret', '--revoke-tokens'], values: [] };

export function createAgentRotateSecretHandler(deps: AgentCommandDeps): CommandHandler {
  return async (ctx, intent): Promise<ExitCode> => {
    const args = parseOrUsage(ctx, intent, ROTATE_SPEC);
    if (args === null) return EXIT_USAGE_ERROR;
    const host = hostOf(ctx, intent);
    const profile = loginProfileOf(ctx, intent);
    if ((await storedAgent(ctx, host, profile)) === null) return EXIT_RUNTIME_ERROR;

    let rotated;
    try {
      rotated = await ctx.sdk.agent.rotateSecret({ revokeExistingTokens: args.revokeTokens });
    } catch (error) {
      ctx.stderr.write(`Could not rotate the agent secret on ${host}: ${describeFailure(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // The old secret is dead the moment the server answered: store the new
    // one before anything else can fail. Re-read first — the call above may
    // have refreshed, and that refresh token is the one to keep.
    const latest = await ctx.credentialStore.get(host, profile);
    if (latest === null || latest.kind !== 'agent') {
      ctx.stderr.write(`The secret was rotated, but the stored agent credential vanished mid-command. New secret: ${rotated.identity_assertion}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    let credential: AgentHostCredential = {
      ...latest,
      secret: rotated.identity_assertion,
      // Revoking the existing tokens killed the refresh token and the key too.
      ...(args.revokeTokens ? { refreshToken: null, contentKeyName: null } : {}),
    };
    await ctx.credentialStore.set(host, credential, profile);

    let provisioning: KeyProvisioning | null = null;
    if (args.revokeTokens) {
      try {
        const { tokenEndpoint } = await deps.discoverTokenEndpoint(host);
        const tokens = await deps.exchange(tokenEndpoint, credential.secret, credential.clientId);
        credential = agentCredentialWithTokens(credential, tokens, deps.now());
        await ctx.credentialStore.set(host, credential, profile);
        provisioning = await provisionAgentKey(ctx, deps, host, profile, credential, () =>
          deps.mintKey({ host, accessToken: tokens.accessToken, name: AGENT_CONTENT_KEY_LABEL }),
        );
      } catch (error) {
        provisioning = { key: null, activated: false, failure: describeFailure(error) };
      }
    }

    if (intent.flags.json) {
      ctx.stdout.write(
        `${JSON.stringify({ host, agentId: rotated.agent_id, secretVersion: rotated.secret_version, revokedExistingTokens: rotated.revoked_existing_tokens, ...(args.showSecret ? { secret: rotated.identity_assertion } : {}) })}\n`,
      );
      return EXIT_SUCCESS;
    }
    const lines = [`Secret rotated (version ${rotated.secret_version}); the old secret no longer works. The new one is stored on this machine.`];
    if (args.revokeTokens) {
      lines.push('Every token and access key this agent held was revoked.');
      if (provisioning !== null) lines.push(...keyLines(host, provisioning));
    }
    lines.push(args.showSecret ? `New secret (shown once): ${rotated.identity_assertion}` : 'The new secret was not printed (pass --show-secret to print it).');
    ctx.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_SUCCESS;
  };
}

// ─── agent create-key ────────────────────────────────────────────────────────

const CREATE_KEY_SPEC: AgentArgsSpec = { booleans: [], values: ['--name'] };

export function createAgentCreateKeyHandler(deps: AgentCommandDeps): CommandHandler {
  return async (ctx, intent): Promise<ExitCode> => {
    const args = parseOrUsage(ctx, intent, CREATE_KEY_SPEC);
    if (args === null) return EXIT_USAGE_ERROR;
    const host = hostOf(ctx, intent);
    const profile = loginProfileOf(ctx, intent);
    const credential = await storedAgent(ctx, host, profile);
    if (credential === null) return EXIT_RUNTIME_ERROR;

    // `ctx.sdk` authenticates as the stored agent credential here (run.ts).
    const provisioning = await provisionAgentKey(ctx, deps, host, profile, credential, async () => {
      const minted = await ctx.sdk.invoke(mintAgentKeyOperation, { name: args.name ?? AGENT_CONTENT_KEY_LABEL });
      return { id: minted.id, token: minted.token };
    });
    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ host, keyName: provisioning.key ? AGENT_CONTENT_KEY_NAME : null, activeKey: provisioning.activated ? AGENT_CONTENT_KEY_NAME : null, error: provisioning.key ? null : provisioning.failure })}\n`);
    } else {
      ctx.stdout.write(`${keyLines(host, provisioning).join('\n')}\n`);
    }
    return provisioning.key === null ? EXIT_RUNTIME_ERROR : EXIT_SUCCESS;
  };
}

// ─── production wiring ───────────────────────────────────────────────────────

const discover = createDiscoverMetadata();

export const AGENT_COMMAND_DEPS: AgentCommandDeps = {
  discoverTokenEndpoint: async (host) => ({ tokenEndpoint: (await discover(host)).tokenEndpoint }),
  exchange: (tokenEndpoint, secret, clientId) => exchangeAgentAssertion(tokenEndpoint, secret, clientId),
  solvePow: (challenge, difficultyBits) => solveAgentPow(challenge, difficultyBits),
  mintKey: mintAgentKey,
  fetchProfile: fetchAccountProfile,
  pollClaim: createPollAgentClaim(),
  readSecret,
  // The REF'D wait: between polls this timer may be the only live handle.
  waitMs,
  now: Date.now,
  createIsInterrupted: createSigintFlag,
};

export const signupHandler: CommandHandler = createSignupHandler(AGENT_COMMAND_DEPS);
export const agentLoginHandler: CommandHandler = createAgentLoginHandler(AGENT_COMMAND_DEPS);
export const agentClaimHandler: CommandHandler = createAgentClaimHandler(AGENT_COMMAND_DEPS);
export const agentRotateSecretHandler: CommandHandler = createAgentRotateSecretHandler(AGENT_COMMAND_DEPS);
export const agentCreateKeyHandler: CommandHandler = createAgentCreateKeyHandler(AGENT_COMMAND_DEPS);
