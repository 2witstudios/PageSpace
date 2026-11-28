/**
 * Request-body shapes for the agent-account routes (L2·G2). Validation only —
 * what a valid body MEANS is decided by `decideAccountCreation` and the
 * authority. The API key travels in exactly one request, is handed to the
 * plane, and is never echoed in any response or log.
 */
import { z } from 'zod';

export const createAgentAccountBody = z
  .object({
    name: z.string().min(1).max(100),
    allowedOrigins: z.array(z.string().min(1).max(2_048)).min(1).max(10),
    ownership: z.enum(['dedicated', 'personal']),
    acknowledged: z.boolean(),
    /** Defaults to `api_key`; a `bearer` token is sent as `Authorization: Bearer <token>` and its placement is ignored. */
    kind: z.enum(['api_key', 'bearer']).optional(),
    apiKey: z.string().min(1).max(8_192),
    placement: z.object({ in: z.enum(['header', 'query']), name: z.string().min(1).max(64) }).strict(),
    allowGenericRequests: z.boolean(),
  })
  .strict();

/** A single-use step-up grant (`/api/auth/step-up/*`) bound to `agentAccountStepUpBinding(accountId)`. */
const stepUpToken = z.string().min(1).max(512).optional();

export const updateAgentAccountBody = z
  .object({
    allowedOrigins: z.array(z.string().min(1).max(2_048)).min(1).max(20),
    autoApprove: z.discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(false) }).strict(),
      z.object({ enabled: z.literal(true), maxUsesPerHour: z.number().int().min(1).max(1_000), until: z.number().int().positive().nullable() }).strict(),
    ]),
    stepUpToken,
  })
  .strict();

export const bindAgentAccountBody = z.object({ agentPageId: z.string().min(1).max(64), stepUpToken }).strict();

/** How long unattended use lasts, in days from now (the SERVER's clock — a skewed browser cannot make 90 days fail). */
export const createDelegationBody = z.object({ agentPageId: z.string().min(1).max(64), days: z.number().int().min(1).max(90), stepUpToken }).strict();

/** What a step-up for a change to this account is bound to — the client asks for exactly this. */
export function agentAccountStepUpBinding(accountId: string): Record<string, string> {
  return { action: 'agent_account_widen', accountId };
}

/** HTTP status per account-change refusal. `step_up_required` is 401 so the client runs the ceremony and retries. */
export const CHANGE_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  account_unavailable: 404,
  page_unavailable: 404,
  step_up_required: 401,
  not_a_consenter: 403,
  consent_unavailable: 503,
  plane_unavailable: 503,
  store_refused: 502,
  conflict: 409,
  bindings_full: 409,
  delegation_unavailable: 404,
};

export const approveAgentAccountRequestBody = z
  .object({
    accountId: z.string().min(1).max(64),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** HTTP status per authority refusal; a refusal body names the reason, never a value. */
export const CREATE_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  forbidden: 403,
  owner_not_found: 404,
  plane_unavailable: 503,
  store_refused: 502,
};
