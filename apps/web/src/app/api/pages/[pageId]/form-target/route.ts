/**
 * Authenticated Forms settings API for a Canvas page — lets the Forms tab
 * (apps/web/.../canvas/CanvasFormsSettingsTab.tsx) create and manage the form
 * target embedded in this Canvas page, without going through the AI tool
 * (apps/web/src/lib/ai/tools/form-tools.ts). `pageId` here is the CANVAS
 * page's id, not the target Sheet's — the form target is looked up by its
 * `canvasPageId` column.
 *
 * The raw submit token is only ever available at creation time (only its
 * hash is persisted — see packages/db/src/schema/form-targets.ts), so POST is
 * the only response that can include a complete, ready-to-embed `formHtml`.
 * PATCH's `add-field` instead returns a standalone field snippet for the user
 * to paste into their already-embedded form.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { formFieldSchema, formFieldsSchema } from '@pagespace/lib/forms/field-schema';
import { buildFormHtml, buildFieldMarkup } from '@pagespace/lib/forms/form-html';
import type { FormTarget } from '@pagespace/db/schema/form-targets';
import {
  createFormTarget,
  getFormTargetByCanvasPageId,
  updateFormTargetFields,
  updateFormTargetStatus,
  FormTargetPageNotSheetError,
  FormTargetAlreadyActiveError,
  FormTargetArchivedError,
  FormTargetFieldLimitError,
  FormTargetDuplicateFieldNameError,
  FormTargetFieldIndexError,
  type FormTargetFieldMutation,
} from '@/services/api/form-target-service';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

function getWebAppUrl(): string {
  const url = process.env.WEB_APP_URL;
  if (!url) {
    throw new Error('WEB_APP_URL must be configured to provision a public form submit URL');
  }
  return url;
}

/** Never send the token hash/prefix to the client — they're internal. */
function sanitizeFormTarget(formTarget: FormTarget) {
  const { tokenHash: _tokenHash, tokenPrefix: _tokenPrefix, ...rest } = formTarget;
  return rest;
}

const createBodySchema = z.object({
  sheetPageId: z.string().min(1),
  fields: formFieldsSchema,
});

const patchBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add-field'), field: formFieldSchema }),
  z.object({
    op: z.literal('update-field'),
    index: z.number().int().min(0),
    patch: z.object({
      label: z.string().optional(),
      required: z.boolean().optional(),
      type: z.enum(['text', 'email', 'textarea', 'checkbox']).optional(),
    }),
  }),
  z.object({ op: z.literal('archive-field'), index: z.number().int().min(0) }),
  z.object({ op: z.literal('unarchive-field'), index: z.number().int().min(0) }),
  z.object({
    op: z.literal('set-status'),
    status: z.enum(['active', 'paused', 'archived']),
    reason: z.string().optional(),
  }),
]);

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to view this page' }, { status: 403 });
  }

  try {
    const formTarget = await getFormTargetByCanvasPageId(pageId);
    return NextResponse.json({ formTarget: formTarget ? sanitizeFormTarget(formTarget) : null });
  } catch (error) {
    loggers.api.error('Error reading form target:', error as Error);
    return NextResponse.json({ error: 'Failed to read form target' }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit this page' }, { status: 403 });
  }

  try {
    const body = createBodySchema.parse(await req.json());
    // Resolve before mutating anything — createFormTarget writes the Sheet
    // header row and inserts the active form_targets row; a WEB_APP_URL
    // misconfiguration discovered afterward would leave that mutation
    // orphaned (the raw token is unrecoverable, and the sheet's "one active
    // target" unique index would then block re-provisioning until someone
    // manually archives the orphaned row).
    const webAppBaseUrl = getWebAppUrl();

    const { token, formTarget } = await createFormTarget({
      sheetPageId: body.sheetPageId,
      fields: body.fields,
      createdBy: userId,
      mutationContext: { userId },
      canvasPageId: pageId,
    });

    const submitUrl = `${webAppBaseUrl}/api/public/forms/${token}/submit`;
    const formHtml = buildFormHtml({ fields: body.fields, submitUrl });

    auditRequest(req, {
      eventType: 'data.write',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'form-target-create', formTargetId: formTarget.id },
    });

    return NextResponse.json({ formTargetId: formTarget.id, submitUrl, formHtml });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    if (error instanceof FormTargetPageNotSheetError || error instanceof FormTargetAlreadyActiveError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    loggers.api.error('Error creating form target:', error as Error);
    return NextResponse.json({ error: 'Failed to create form target' }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit this page' }, { status: 403 });
  }

  try {
    const existing = await getFormTargetByCanvasPageId(pageId);
    if (!existing) {
      return NextResponse.json({ error: 'No form target is set up on this page' }, { status: 404 });
    }

    const body = patchBodySchema.parse(await req.json());

    let updated: FormTarget;
    let fieldSnippet: string | undefined;

    if (body.op === 'set-status') {
      updated = await updateFormTargetStatus({
        formTargetId: existing.id,
        status: body.status,
        statusReason: body.reason,
      });
    } else {
      const mutation = body as FormTargetFieldMutation;
      updated = await updateFormTargetFields({
        formTargetId: existing.id,
        mutation,
        mutationContext: { userId },
      });
      if (mutation.op === 'add-field') {
        fieldSnippet = buildFieldMarkup(mutation.field);
      }
    }

    auditRequest(req, {
      eventType: 'data.write',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'form-target-update', formTargetId: existing.id, op: body.op },
    });

    return NextResponse.json({ formTarget: sanitizeFormTarget(updated), fieldSnippet });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    if (
      error instanceof FormTargetFieldLimitError ||
      error instanceof FormTargetDuplicateFieldNameError ||
      error instanceof FormTargetFieldIndexError ||
      error instanceof FormTargetArchivedError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    loggers.api.error('Error updating form target:', error as Error);
    return NextResponse.json({ error: 'Failed to update form target' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit this page' }, { status: 403 });
  }

  try {
    const existing = await getFormTargetByCanvasPageId(pageId);
    if (!existing) {
      return NextResponse.json({ error: 'No form target is set up on this page' }, { status: 404 });
    }

    await updateFormTargetStatus({ formTargetId: existing.id, status: 'archived' });

    auditRequest(req, {
      eventType: 'data.delete',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'form-target-archive', formTargetId: existing.id },
    });

    return NextResponse.json({ archived: true });
  } catch (error) {
    loggers.api.error('Error archiving form target:', error as Error);
    return NextResponse.json({ error: 'Failed to archive form target' }, { status: 500 });
  }
}
