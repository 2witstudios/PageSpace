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
} from '@/services/api/form-target-service';
import { buildFormHtml } from '@pagespace/lib/forms/form-html';

function getWebAppUrl(): string {
  const url = process.env.WEB_APP_URL;
  if (!url) {
    throw new Error('WEB_APP_URL must be configured to provision a public form submit URL');
  }
  return url;
}

const formFieldSchema = z.object({
  name: z.string().describe('Stable field key — used as the <input name="..."> and the submitted JSON key'),
  label: z.string().describe('Header-row column label, e.g. "Email"'),
  type: z.enum(['text', 'email', 'textarea', 'checkbox']),
  required: z.boolean().default(true),
});

// Exported (not just used inline) so tests can exercise validation directly —
// the `ai` package's `tool()` wrapper doesn't expose zod's `.safeParse` in its
// public type, even though the runtime schema is unchanged.
export const formFieldsSchema = z
  .array(formFieldSchema)
  .min(1)
  .max(20)
  .refine(
    (fields) => new Set(fields.map((field) => field.name)).size === fields.length,
    { message: 'Field names must be unique — a duplicate name silently drops the earlier value on submit' }
  );

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
    }),
    execute: async ({ sheetPageId, fields }, { experimental_context: context }) => {
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
        });

        const submitUrl = `${getWebAppUrl()}/api/public/forms/${token}/submit`;
        const formHtml = buildFormHtml({ fields, submitUrl });

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

      const updated = await updateFormTargetStatus({ formTargetId, status, statusReason: reason });
      return { success: true, formTargetId: updated.id, pageId: existing.pageId, status: updated.status };
    },
  }),
};
