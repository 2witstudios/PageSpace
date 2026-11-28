/**
 * Agent identities (ADR 0008; Agent Signup Phase 5) — an AI agent creating,
 * funding and maintaining its OWN PageSpace account, with no email address and
 * no human in the loop. Not to be confused with `agents.*` (AI agent PAGES in a
 * drive): these operations are about the caller's identity itself.
 *
 * The flow `/auth.md` documents, one operation per step:
 *
 *   agent.challenge   GET  /api/agent/challenge      proof-of-work challenge   (unauthenticated)
 *   agent.signup      POST /api/agent/identity       register → one-time secret (unauthenticated)
 *   exchangeAgentAssertion(tokenEndpoint, secret, 'pagespace-agent')   → ps_at_/ps_rt_ (auth/agent-assertion.ts)
 *   agent.claim       POST /api/agent/claim          a user code a human approves (agent's access token)
 *   pollAgentClaim(tokenEndpoint, accessToken, 'pagespace-agent')     → {claimed, owner} (auth/agent-claim.ts)
 *   agent.rotateSecret POST /api/agent/secret/rotate  new one-time secret        (agent's access token)
 *
 * Route-verified against `apps/web/src/app/api/agent/{challenge,identity,secret/rotate}`
 * and the claim contract in `auth-md.ts`'s Fund section. Input bounds mirror the
 * server's zod so a bad name fails before a proof-of-work is paid for. Every
 * input schema is strict, nested objects included.
 *
 * The secret (`identity_assertion`) appears in exactly two responses, both
 * shown once. Callers must store it where they keep credentials and never log
 * it; the SDK holds nothing.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/** The server's own bounds (`apps/web/src/app/api/agent/identity/route.ts`, `@pagespace/lib/auth/agent/pow`). */
const NAME_MAX = 80;
const SOURCE_MAX = 120;
const CHALLENGE_MAX = 256;
const NONCE_MAX = 64;
const POW_MAX_DIFFICULTY_BITS = 64;

export const getAgentChallenge = defineOperation({
  name: 'agent.challenge',
  method: 'GET',
  path: '/api/agent/challenge',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    challenge: z.string().min(1).max(CHALLENGE_MAX),
    difficulty_bits: z.number().int().min(1).max(POW_MAX_DIFFICULTY_BITS),
    expires_in: z.number(),
    algorithm: z.literal('sha3-256'),
    input: z.string(),
  }),
  unauthenticated: true,
  description:
    'Fetch a single-use proof-of-work challenge for agent signup. Find a nonce such that SHA3-256("<challenge>:<nonce>") has at least difficulty_bits leading zero bits, then call agent.signup within expires_in seconds.',
});

export const signUpAgent = defineOperation({
  name: 'agent.signup',
  method: 'POST',
  path: '/api/agent/identity',
  inputSchema: z.strictObject({
    type: z.literal('anonymous'),
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    /** Which agent/runtime you are ("claude-code", "codex", …). Display only. */
    source: z.string().trim().min(1).max(SOURCE_MAX).optional(),
    tos_accepted: z.boolean(),
    pow: z.strictObject({
      challenge: z.string().min(1).max(CHALLENGE_MAX),
      nonce: z.string().min(1).max(NONCE_MAX),
    }),
  }),
  outputSchema: z.object({
    /** The agent's secret. Shown ONCE — store it; anyone holding it is this agent. */
    identity_assertion: z.string().min(1),
    agent_id: z.string().min(1),
    account_type: z.literal('agent'),
    token_endpoint: z.string(),
    grant_type: z.string(),
    client_id: z.string(),
    claim_endpoint: z.string(),
  }),
  unauthenticated: true,
  description:
    'Create an AI agent account (no email). Requires a solved agent.challenge and tos_accepted: true. Returns identity_assertion (the secret, shown once) — the only credential the agent holds; exchange it for tokens with exchangeAgentAssertion.',
});

export const claimAgent = defineOperation({
  name: 'agent.claim',
  method: 'POST',
  path: '/api/agent/claim',
  /** Nothing: the agent's own access token is the credential (security review addendum to ADR 0008). */
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    user_code: z.string().min(1),
    verification_uri: z.string().min(1),
    /** Hand this to the human: they sign in, see what they agree to, and approve. */
    verification_uri_complete: z.string().min(1),
    expires_in: z.number(),
    /** Poll the claim grant no faster than this many seconds. */
    interval: z.number(),
  }),
  requiredScope: 'account',
  description:
    "Start a claim with the agent's own access token: returns a user code and verification_uri_complete for a human to approve. Once approved the human owns the agent, pays for its AI usage and may rotate its secret, so hand the link only to the intended owner. Poll with pollAgentClaim at interval seconds; the claim mints no tokens.",
});

export const rotateAgentSecret = defineOperation({
  name: 'agent.rotateSecret',
  method: 'POST',
  path: '/api/agent/secret/rotate',
  inputSchema: z.strictObject({
    /** Only an owner naming one of its agents passes this (and only from a web session); an agent rotates itself. */
    agentId: z.string().min(1).max(64).optional(),
    /** Also kill every live access token, refresh token and mcp_ key — for a secret that may have leaked. */
    revokeExistingTokens: z.boolean().optional(),
  }),
  outputSchema: z.object({
    /** The NEW secret, shown once. The old one stopped working when this returned. */
    identity_assertion: z.string().min(1),
    agent_id: z.string(),
    secret_version: z.number(),
    revoked_existing_tokens: z.boolean(),
  }),
  requiredScope: 'account',
  description:
    "Replace the agent's secret. The new secret is returned once; the old one stops working immediately. revokeExistingTokens: true also revokes every live token and mcp_ key.",
});
