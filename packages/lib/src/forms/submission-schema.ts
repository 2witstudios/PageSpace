import { z } from 'zod';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const FIELD_MAX_LENGTH: Record<FormFieldDef['type'], number> = {
  text: 500,
  email: 254,
  textarea: 5000,
  checkbox: 0,
};

function buildFieldSchema(field: FormFieldDef): z.ZodTypeAny {
  const base =
    field.type === 'checkbox'
      ? z.boolean()
      : field.type === 'email'
        ? z.string().trim().max(FIELD_MAX_LENGTH.email).email()
        : z.string().trim().max(FIELD_MAX_LENGTH[field.type]);

  if (field.type === 'checkbox') {
    return field.required ? base : base.optional();
  }

  const stringBase = base as z.ZodString;
  return field.required ? stringBase.min(1) : stringBase.optional();
}

export type SubmissionValues = Record<string, string | boolean>;

/**
 * Builds a strict zod object schema from a form's stored field definitions —
 * unknown keys are rejected (no passthrough), so a submission can never smuggle
 * extra data past the fields the form was provisioned with.
 */
export function buildSubmissionSchema(fields: FormFieldDef[]): z.ZodType<SubmissionValues> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field.name] = buildFieldSchema(field);
  }
  return z.object(shape).strict() as unknown as z.ZodType<SubmissionValues>;
}
