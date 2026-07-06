import { describe, it, expect } from 'vitest';
import { buildHeaderRowUpdates, buildSubmissionRowUpdates } from '../cell-mapping';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const fields: FormFieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'subscribe', label: 'Subscribe?', type: 'checkbox', required: false },
];

describe('buildHeaderRowUpdates', () => {
  it('maps each field label to its column at the header row', () => {
    const updates = buildHeaderRowUpdates(fields, 1);
    expect(updates).toEqual([
      { address: 'A1', value: 'Name' },
      { address: 'B1', value: 'Email' },
      { address: 'C1', value: 'Subscribe?' },
    ]);
  });

  it('offsets to the correct row for a non-default header row', () => {
    const updates = buildHeaderRowUpdates(fields, 3);
    expect(updates.map((u) => u.address)).toEqual(['A3', 'B3', 'C3']);
  });

  it('skips an archived field, leaving its column header untouched, without shifting later columns', () => {
    const withArchived: FormFieldDef[] = [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true, archived: true },
      { name: 'subscribe', label: 'Subscribe?', type: 'checkbox', required: false },
    ];

    const updates = buildHeaderRowUpdates(withArchived, 1);
    expect(updates).toEqual([
      { address: 'A1', value: 'Name' },
      { address: 'C1', value: 'Subscribe?' },
    ]);
  });
});

describe('buildSubmissionRowUpdates', () => {
  it('maps submitted values to the correct columns at the target row', () => {
    const updates = buildSubmissionRowUpdates(fields, 2, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      subscribe: true,
    });

    expect(updates).toEqual([
      { address: 'A2', value: 'Ada Lovelace' },
      { address: 'B2', value: 'ada@example.com' },
      { address: 'C2', value: 'true' },
    ]);
  });

  it('formats a false checkbox value as the string "false"', () => {
    const updates = buildSubmissionRowUpdates(fields, 2, {
      name: 'Ada',
      email: 'ada@example.com',
      subscribe: false,
    });

    expect(updates.find((u) => u.address === 'C2')).toEqual({ address: 'C2', value: 'false' });
  });

  it('omits a cell for a field with no submitted value', () => {
    const updates = buildSubmissionRowUpdates(fields, 2, {
      name: 'Ada',
      email: 'ada@example.com',
    });

    expect(updates.map((u) => u.address)).toEqual(['A2', 'B2']);
  });

  it('appends further down the sheet for a later row', () => {
    const updates = buildSubmissionRowUpdates(fields, 100, {
      name: 'Ada',
      email: 'ada@example.com',
    });

    expect(updates.map((u) => u.address)).toEqual(['A100', 'B100']);
  });

  it('skips an archived field without shifting later fields off their column', () => {
    const withArchived: FormFieldDef[] = [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true, archived: true },
      { name: 'subscribe', label: 'Subscribe?', type: 'checkbox', required: false },
    ];

    const updates = buildSubmissionRowUpdates(withArchived, 2, {
      name: 'Ada',
      email: 'ada@example.com',
      subscribe: true,
    });

    // email (index 1 / column B) is dropped; subscribe stays at its original
    // column C, not shifted left to B.
    expect(updates).toEqual([
      { address: 'A2', value: 'Ada' },
      { address: 'C2', value: 'true' },
    ]);
  });
});
