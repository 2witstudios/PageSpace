import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError, canManagePageWebhooks } from '@/lib/auth';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/** Strip the encrypted secret from every response — the new plaintext is returned exactly once, below. */
function toPublicWebhook(row: typeof pageWebhooks.$inferSelect) {
  const { webhookSecretEncrypted: _webhookSecretEncrypted, ...publicRow } = row;
  return publicRow;
}

// POST /api/pages/[pageId]/webhooks/[id]/rotate — mint a new signing secret in
// place. The webhookToken (and thus the URL) is untouched, so the external
// sender only swaps the secret; deliveries signed with the old secret stop
// verifying the moment the row is updated.
export async function POST(request: Request, context: { params: Promise<{ pageId: string; id: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { pageId, id } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    const existing = await db.query.pageWebhooks.findFirst({
      where: and(eq(pageWebhooks.id, id), eq(pageWebhooks.pageId, pageId)),
    });
    if (!existing) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });

    const webhookSecretPlaintext = randomBytes(32).toString('base64url');
    const webhookSecretEncrypted = await encryptField(webhookSecretPlaintext);

    // Optimistic-concurrency guard: encryption is randomized, so the stored
    // ciphertext is unique per write — conditioning on the value we just read
    // means a concurrent rotation makes this update match zero rows instead of
    // silently overwriting (which would 200 both callers but leave one holding
    // a plaintext secret that never verifies).
    const [row] = await db
      .update(pageWebhooks)
      .set({ webhookSecretEncrypted })
      .where(and(
        eq(pageWebhooks.id, id),
        eq(pageWebhooks.webhookSecretEncrypted, existing.webhookSecretEncrypted),
      ))
      .returning();
    if (!row) {
      return NextResponse.json(
        { error: 'The secret was rotated by a concurrent request — use that rotation\'s secret or rotate again' },
        { status: 409 },
      );
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'page_webhook',
      resourceId: id,
      details: { operation: 'rotate', pageId },
    });

    return NextResponse.json({
      webhook: toPublicWebhook(row),
      // Returned exactly once — the plaintext secret is never persisted or re-derivable after this response.
      webhookSecret: webhookSecretPlaintext,
    });
  } catch (error) {
    loggers.api.error('Error rotating page webhook secret', error as Error);
    return NextResponse.json({ error: 'Failed to rotate webhook secret' }, { status: 500 });
  }
}
