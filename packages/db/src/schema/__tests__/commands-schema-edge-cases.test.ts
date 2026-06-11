/**
 * Universal Commands phase 6 — schema-level proof of the hard-delete
 * degradation contract (UX spec §5.2, launch hardening):
 *
 *  - entry page hard-deleted  → command row cascade-deleted (chips resolve
 *    `deleted`, the resolver skips not_found — covered in apps/web tests);
 *  - drive deleted            → that drive's command rows cascade-deleted;
 *  - user deleted             → their personal command rows cascade-deleted;
 *  - author deleted           → provenance nulls out, the command survives.
 *
 * These run without a database: they assert the Drizzle FK/constraint
 * definitions that the migrations were generated from. If someone drops a
 * cascade, every "chip degrades instead of erroring" guarantee silently
 * breaks — this test makes that loud.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { commands, commandsRelations } from '../commands';

const config = getTableConfig(commands);
const columns = getTableColumns(commands);

function fkOnColumn(columnName: string) {
  const fk = config.foreignKeys.find((candidate) =>
    candidate.reference().columns.some((column) => column.name === columnName)
  );
  expect(fk, `expected a foreign key on ${columnName}`).toBeDefined();
  return fk!;
}

describe('commands schema — cascade contract', () => {
  it('cascade-deletes the command when its entry page is hard-deleted', () => {
    const fk = fkOnColumn('entry_page_id');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('pages');
    expect(fk.onDelete).toBe('cascade');
  });

  it('cascade-deletes drive commands when the drive is deleted', () => {
    expect(fkOnColumn('drive_id').onDelete).toBe('cascade');
  });

  it('cascade-deletes personal commands when the owning user is deleted', () => {
    expect(fkOnColumn('user_id').onDelete).toBe('cascade');
  });

  it('keeps the command but clears provenance when the author account is deleted', () => {
    expect(fkOnColumn('created_by_id').onDelete).toBe('set null');
  });
});

describe('commands schema — scope and uniqueness invariants', () => {
  it('requires exactly one of userId/driveId via the scope check constraint', () => {
    const scopeCheck = config.checks.find((check) => check.name === 'commands_scope_chk');
    expect(scopeCheck).toBeDefined();
  });

  it('enforces per-scope trigger uniqueness (personal and drive)', () => {
    const names = config.uniqueConstraints.map((constraint) => constraint.name);
    expect(names).toContain('commands_user_trigger');
    expect(names).toContain('commands_drive_trigger');
  });

  it('requires entryPageId, trigger, and description (a command can never half-exist)', () => {
    expect(columns.entryPageId.notNull).toBe(true);
    expect(columns.trigger.notNull).toBe(true);
    expect(columns.description.notNull).toBe(true);
  });

  it('exports relations for the resolver join paths', () => {
    expect(commandsRelations).toBeDefined();
  });
});
