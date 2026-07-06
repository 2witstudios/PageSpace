import { tool } from 'ai';
import { z } from 'zod';
import { canActorEditPage } from './actor-permissions';
import type { ToolExecutionContext } from '../core/types';
import {
  createFormTarget,
  updateFormTargetStatus,
  getFormTargetById,
  FormTargetPageNotSheetError,
  FormTargetAlreadyActiveError,
  FormTargetArchivedError,
} from '@/services/api/form-target-service';
import { buildFormHtml } from '@pagespace/lib/forms/form-html';
// Shared with the Forms settings API route (apps/web/src/app/api/pages/[pageId]/form-target)
// so a brand-new field list is validated identically whether it comes from
// an AI agent or the settings UI.
import { formFieldsSchema } from '@pagespace/lib/forms/field-schema';

export { formFieldsSchema };

function getWebAppUrl(): string {
  const url = process.env.WEB_APP_URL;
  if (!url) {
    throw new Error('WEB_APP_URL must be configured to provision a public form submit URL');
  }
  return url;
}

export const formTools = {
  provision_form_target: tool({
    description:
      'Wire a plain HTML <form> to a SHEET page so public submissions append as new rows. ' +
      'Use this when a Canvas page needs a signup/waitlist/quote/feedback form. Call this FIRST, ' +
      'then embed the returned formHtml verbatim into the Canvas page body — do not modify the ' +
      'hidden honeypot field or the fetch() call, those are required for spam protection. Returns ' +
      'a public submit token embedded in formHtml — safe to publish, it authorizes ONLY appending ' +
      'rows to this one sheet, nothing else.',
    inputSchema: z.object({
      sheetPageId: z.string().describe('The target SHEET page that will receive one new row per submission'),
      fields: formFieldsSchema,
      canvasPageId: z
        .string()
        .optional()
        .describe('The Canvas page formHtml will be embedded into, if known — lets the Forms settings UI find and manage this target later'),
    }),
    execute: async ({ sheetPageId, fields, canvasPageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const canEdit = await canActorEditPage(context as ToolExecutionContext, sheetPageId);
      if (!canEdit) {
        throw new Error('Insufficient permissions to provision a form on this page');
      }

      try {
        const { token, formTarget } = await createFormTarget({
          sheetPageId,
          fields,
          createdBy: userId,
          mutationContext: { userId, isAiGenerated: true },
          canvasPageId,
        });

        const submitUrl = `${getWebAppUrl()}/api/public/forms/${token}/submit`;
        // Same `pagespace-form-{id}` convention wireFormBlock assigns when the
        // Forms settings tab wires up a hand-authored tag — so the tab can
        // recognize a form provisioned this way as already-wired too, instead
        // of mistaking it for a bare, unwired <form>.
        const formHtml = buildFormHtml({ fields, submitUrl, formId: `pagespace-form-${formTarget.id}` });

        return {
          success: true,
          formTargetId: formTarget.id,
          pageId: sheetPageId,
          submitUrl,
          formHtml,
          message: `Form target provisioned on sheet "${sheetPageId}". Embed formHtml verbatim into the Canvas page.`,
        };
      } catch (error) {
        if (error instanceof FormTargetPageNotSheetError || error instanceof FormTargetAlreadyActiveError) {
          return { success: false, error: error.message };
        }
        throw error;
      }
    },
  }),

  update_form_target_status: tool({
    description:
      'Pause, resume, or permanently archive a form target created by provision_form_target. ' +
      'Pausing takes effect immediately for all future submissions — use this to stop spam without ' +
      'deleting the form target (resumable). Archiving is permanent.',
    inputSchema: z.object({
      formTargetId: z.string(),
      status: z.enum(['active', 'paused', 'archived']),
      reason: z.string().optional(),
    }),
    execute: async ({ formTargetId, status, reason }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const existing = await getFormTargetById(formTargetId);
      if (!existing) {
        throw new Error(`Form target "${formTargetId}" not found`);
      }

      const canEdit = await canActorEditPage(context as ToolExecutionContext, existing.pageId);
      if (!canEdit) {
        throw new Error('Insufficient permissions to update this form target');
      }

      try {
        const updated = await updateFormTargetStatus({ formTargetId, status, statusReason: reason });
        return { success: true, formTargetId: updated.id, pageId: existing.pageId, status: updated.status };
      } catch (error) {
        if (error instanceof FormTargetArchivedError) {
          return { success: false, error: error.message };
        }
        throw error;
      }
    },
  }),
};
