import { z } from 'zod/v4';

/**
 * The shared validation contract for admin email broadcasts.
 *
 * CLIENT-SAFE ON PURPOSE: this module imports zod and nothing else, so the
 * composer form and the API route handlers parse the exact same schema. A form
 * that validates differently than the route is a form that lies to the admin
 * about what will be accepted.
 *
 * Mirrors `BroadcastAudienceDefinition` in `@pagespace/db/schema/email-broadcasts`
 * (not imported — that module pulls drizzle into the client bundle). Standard
 * exclusions (opted-out, GDPR-restricted, suspended) are deliberately NOT
 * representable here; `audience.ts` applies them in code on every resolve.
 */

export const audienceDefinitionSchema = z
  .object({
    /** The ONLY standard exclusion an operator may lift, opt-in per broadcast. */
    includeUnverified: z.boolean().optional(),
    /** `users.subscriptionTier` values to include. Absent/empty = every tier. */
    planTiers: z.array(z.string().trim().min(1)).max(50).optional(),
    /** ISO-8601 instants bounding `users.createdAt` (inclusive). */
    signupAfter: z.iso.datetime({ offset: true }).optional(),
    signupBefore: z.iso.datetime({ offset: true }).optional(),
    /** Hand-picked recipients — still subject to every standard exclusion. */
    userIds: z.array(z.string().trim().min(1)).max(10000).optional(),
  })
  .superRefine((value, ctx) => {
    // Lives HERE rather than only on the create schema so every consumer of the
    // audience contract rejects an inverted window — a definition that quietly
    // resolves to zero recipients is a validation failure, not a targeting choice.
    if (value.signupAfter && value.signupBefore && new Date(value.signupAfter) > new Date(value.signupBefore)) {
      ctx.addIssue({
        code: 'custom',
        path: ['signupBefore'],
        message: 'signupBefore must not precede signupAfter.',
      });
    }
  });

/**
 * POST /api/admin/broadcasts body.
 *
 * `subject` may be empty ONLY in template mode: `resolveBroadcastContent` falls
 * back to the template's own subject, so an admin can reuse a template without
 * retyping (or overriding) its subject line. Compose mode has no fallback.
 *
 * The output is NORMALIZED by the trailing transform: only the field the active
 * contentMode reads survives parsing (`templateId` in template mode,
 * `bodyMarkdown` in compose mode). Stale cross-mode form state — a template id
 * kept after switching to compose — must never reach persistence, where it
 * would break the insert on a deleted-template FK or record a template the
 * send never used. Normalizing in the schema means every consumer of a parsed
 * value inherits the invariant instead of re-asserting it.
 */
export const broadcastCreateSchema = z
  .object({
    subject: z.string().trim().max(200).default(''),
    engine: z.enum(['transactional', 'resend_broadcast']).default('transactional'),
    contentMode: z.enum(['compose', 'template']),
    templateId: z.string().trim().min(1).optional(),
    bodyMarkdown: z.string().trim().min(1).max(100000).optional(),
    audienceDefinition: audienceDefinitionSchema.default({}),
    /** Never defaulted: the caller must SAY whether this is a rehearsal or a send. */
    dryRun: z.boolean(),
    /** Canary cap — counts attempts, not successes. */
    sendLimit: z.number().int().min(1).max(1000000).optional(),
    /** Pause between sends. Bounded so a typo can't stall a job for hours per recipient. */
    delayMs: z.number().int().min(0).max(60000).optional(),
    /**
     * Escape hatch for the active-duplicate guard: a live create whose subject
     * matches a still-active broadcast is refused (409) unless this is set —
     * a double-clicked Send or a proxy-retried POST must not mail everyone twice.
     */
    allowDuplicate: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.contentMode === 'compose') {
      if (!value.subject) {
        ctx.addIssue({
          code: 'custom',
          path: ['subject'],
          message: 'A composed broadcast needs a subject.',
        });
      }
      if (!value.bodyMarkdown) {
        ctx.addIssue({
          code: 'custom',
          path: ['bodyMarkdown'],
          message: 'A composed broadcast needs a markdown body.',
        });
      }
    } else if (!value.templateId) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'A template broadcast must name a template.',
      });
    }

    // Phase 1 ships the transactional engine only. Enforced in the SHARED
    // schema — not just the route — so the composer form flags a live
    // resend_broadcast send at validation time instead of after a round trip.
    // (Dry runs are engine-independent: count + preview render the same.)
    if (value.engine === 'resend_broadcast' && !value.dryRun) {
      ctx.addIssue({
        code: 'custom',
        path: ['engine'],
        message: 'The resend_broadcast engine is not available yet. Use "transactional".',
      });
    }
  })
  .transform((value) => ({
    ...value,
    templateId: value.contentMode === 'template' ? value.templateId : undefined,
    bodyMarkdown: value.contentMode === 'compose' ? value.bodyMarkdown : undefined,
  }));

export type BroadcastCreateInput = z.infer<typeof broadcastCreateSchema>;

/** POST /api/admin/broadcasts/[id] body — operator intervention on a live send. */
export const broadcastActionSchema = z.object({
  action: z.enum(['cancel', 'pause']),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

/** POST /api/admin/broadcasts/templates body. */
export const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().trim().min(1).max(100000),
  isActive: z.boolean().default(true),
});
