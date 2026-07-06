import { describe, it, expect } from 'vitest';
import { buildSubmissionSchema } from '../submission-schema';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const fields: FormFieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'notes', label: 'Notes', type: 'textarea', required: false },
  { name: 'subscribe', label: 'Subscribe', type: 'checkbox', required: false },
];

describe('buildSubmissionSchema', () => {
  it('accepts a payload matching every field type', () => {
    const schema = buildSubmissionSchema(fields);
    const result = schema.safeParse({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      notes: 'Looking forward to it',
      subscribe: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const schema = buildSubmissionSchema(fields);
    const result = schema.safeParse({ email: 'ada@example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email value', () => {
    const schema = buildSubmissionSchema(fields);
    const result = schema.safeParse({ name: 'Ada', email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field name (no passthrough)', () => {
    const schema = buildSubmissionSchema(fields);
    const result = schema.safeParse({
      name: 'Ada',
      email: 'ada@example.com',
      injectedField: 'should not be allowed',
    });
    expect(result.success).toBe(false);
  });

  it('allows omitting a field that is not required', () => {
    const schema = buildSubmissionSchema(fields);
    const result = schema.safeParse({ name: 'Ada', email: 'ada@example.com' });
    expect(result.success).toBe(true);
  });

  it('coerces a checkbox field to boolean and rejects non-boolean values', () => {
    const schema = buildSubmissionSchema(fields);
    const rejected = schema.safeParse({
      name: 'Ada',
      email: 'ada@example.com',
      subscribe: 'yes',
    });
    expect(rejected.success).toBe(false);
  });
});
