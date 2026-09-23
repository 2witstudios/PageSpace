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
    apiKey: z.string().min(1).max(8_192),
    placement: z.object({ in: z.enum(['header', 'query']), name: z.string().min(1).max(64) }).strict(),
    allowGenericRequests: z.boolean(),
  })
  .strict();

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
