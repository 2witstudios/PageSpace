/**
 * The web ↔ credential-plane wire shapes (L2·G2): one schema per route, used
 * by the plane to parse what arrives and by the client to type what it sends.
 * Nothing here is secret except `put.material`, which travels once, inbound,
 * over the plane's own listener, and is never echoed.
 */
import { z } from 'zod';

const ref = z.object({ tenantId: z.string().min(1), accountId: z.string().min(1), kind: z.literal('api_key') }).strict();

export const planePutBody = z
  .object({
    ref,
    material: z
      .object({
        kind: z.literal('api_key'),
        material: z.object({ value: z.string().min(1).max(8_192), placement: z.object({ in: z.enum(['header', 'query']), name: z.string().min(1).max(64) }).strict() }).strict(),
      })
      .strict(),
    bindings: z.record(z.string(), z.unknown()),
    scope: z.record(z.string(), z.unknown()),
    consenters: z.union([z.object({ kind: z.literal('owner') }).strict(), z.object({ kind: z.literal('pinned'), userIds: z.array(z.string().min(1)).min(1) }).strict()]),
  })
  .strict();

export const planeRevokeBody = z.object({ ref }).strict();

export const planeExecuteBody = z
  .object({
    grant: z.unknown(),
    signature: z.string().min(1).max(512),
    request: z
      .object({
        method: z.string().min(1).max(16),
        url: z.string().min(1).max(8_192),
        headers: z.record(z.string(), z.string()),
        /** Base64 of the exact body bytes. ~1 MiB of body at most. */
        bodyBase64: z.string().max(1_400_000),
      })
      .strict(),
    run: z
      .object({
        human: z.object({ userId: z.string().min(1), sessionId: z.string().min(1).nullable() }).strict(),
        agentPageId: z.string().min(1).nullable(),
        conversationId: z.string().min(1),
        runId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type PlanePutBody = z.infer<typeof planePutBody>;
export type PlaneRevokeBody = z.infer<typeof planeRevokeBody>;
export type PlaneExecuteBody = z.infer<typeof planeExecuteBody>;

export const PLANE_ROUTES = { put: '/v1/accounts/put', revoke: '/v1/accounts/revoke', execute: '/v1/http/execute' } as const;
