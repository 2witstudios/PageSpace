import { z } from 'zod';

// Object-prototype own-properties: assigning `shape[name] = ...` on a plain
// object literal (as buildSubmissionSchema does) silently sets the
// PROTOTYPE instead of an own property for these three keys, so a field
// using one of them would vanish from the built zod schema instead of
// erroring — reject them up front rather than let them fail silently later.
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export const formFieldSchema = z.object({
  name: z
    .string()
    .min(1, 'Field name is required')
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Field name may only contain letters, numbers, underscores, and hyphens')
    .refine((name) => !RESERVED_FIELD_NAMES.has(name), {
      message: 'Field name is reserved and cannot be used',
    })
    .describe('Stable field key — used as the <input name="..."> and the submitted JSON key'),
  label: z.string().min(1, 'Field label is required').describe('Header-row column label, e.g. "Email"'),
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
