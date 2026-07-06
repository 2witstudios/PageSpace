import { z } from 'zod';

export const formFieldSchema = z.object({
  name: z.string().describe('Stable field key — used as the <input name="..."> and the submitted JSON key'),
  label: z.string().describe('Header-row column label, e.g. "Email"'),
  type: z.enum(['text', 'email', 'textarea', 'checkbox']),
  required: z.boolean().default(true),
});

// Exported (not just used inline) so callers — the AI tool and the Forms
// settings API route — validate a brand-new field list identically.
export const formFieldsSchema = z
  .array(formFieldSchema)
  .min(1)
  .max(20)
  .refine(
    (fields) => new Set(fields.map((field) => field.name)).size === fields.length,
    { message: 'Field names must be unique — a duplicate name silently drops the earlier value on submit' }
  );
