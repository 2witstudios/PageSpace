import { describe, it, expect } from 'vitest';
import { formFieldSchema, formFieldsSchema } from '../field-schema';

const validField = { name: 'email', label: 'Email', type: 'email' as const, required: true };

describe('formFieldSchema', () => {
  it('accepts a well-formed field', () => {
    expect(formFieldSchema.safeParse(validField).success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = formFieldSchema.safeParse({ ...validField, name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty label', () => {
    const result = formFieldSchema.safeParse({ ...validField, label: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a name with characters outside letters/numbers/underscore/hyphen', () => {
    const result = formFieldSchema.safeParse({ ...validField, name: 'first name' });
    expect(result.success).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the reserved name "%s" (silently dropped by buildSubmissionSchema\'s shape[name] assignment)',
    (name) => {
      const result = formFieldSchema.safeParse({ ...validField, name });
      expect(result.success).toBe(false);
    }
  );
});

describe('formFieldsSchema', () => {
  it('rejects duplicate names', () => {
    const result = formFieldsSchema.safeParse([validField, { ...validField, label: 'Email 2' }]);
    expect(result.success).toBe(false);
  });
});
