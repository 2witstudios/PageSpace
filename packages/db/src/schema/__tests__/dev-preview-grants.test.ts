/**
 * `dev_preview_grants` — schema-level proof of what the single-use handoff
 * relies on. Runs without a database: it asserts the Drizzle declarations the
 * migration was generated from, and that the migration exists.
 *
 *  - **The id is the capability and has NO default.** The store generates 256
 *    random bits; a `$defaultFn(createId)` appearing here would make grants
 *    guessable (cuids are unique, not secret).
 *  - **The user cascades; the holder does not.** A deleted user leaves no
 *    grant behind. The holder is named polymorphically (kind + id, CHECKed to
 *    the two kinds) on purpose — see the table docblock.
 *  - **Both expiries are NOT NULL.** A grant with no redemption window or no
 *    cookie lifetime would be a permanent capability.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { devPreviewGrants } from '../dev-preview-grants';
import { users } from '../auth';
import { schema } from '../../schema';

const config = getTableConfig(devPreviewGrants);
const columns = getTableColumns(devPreviewGrants);

describe('dev_preview_grants schema', () => {
  it('is registered in the shared schema (so migrations and the query builder see it)', () => {
    expect(schema.devPreviewGrants).toBe(devPreviewGrants);
  });

  it('has an id with NO default — the store mints the capability', () => {
    expect(columns.id.primary).toBe(true);
    expect(columns.id.hasDefault).toBe(false);
    expect(columns.id.defaultFn).toBeUndefined();
  });

  it('cascades with the user and names the holder polymorphically', () => {
    const userFk = config.foreignKeys.find((fk) => fk.reference().foreignTable === users);
    expect(userFk?.onDelete).toBe('cascade');
    expect(config.foreignKeys).toHaveLength(1);
    expect(columns.holderKind.notNull).toBe(true);
    expect(columns.holderId.notNull).toBe(true);
    expect(config.checks.map((c) => c.name)).toEqual(['dev_preview_grants_holder_kind_check']);
  });

  it('requires both expiries and leaves consumedAt nullable (the single-use stamp)', () => {
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.cookieExpiresAt.notNull).toBe(true);
    expect(columns.consumedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.createdAt.hasDefault).toBe(false);
  });

  it('indexes expiresAt for the sweep', () => {
    expect(config.indexes.map((i) => i.config.name)).toEqual(['dev_preview_grants_expires_at_idx']);
  });

  it('has exactly one migration creating it, with the cascade and the CHECK in SQL', () => {
    const drizzleDir = path.resolve(__dirname, '../../../drizzle');
    const creating = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(path.join(drizzleDir, f), 'utf8'))
      .filter((sql) => sql.includes('CREATE TABLE "dev_preview_grants"'));
    expect(creating).toHaveLength(1);
    expect(creating[0]).toContain('ON DELETE cascade');
    expect(creating[0]).toContain(`"holderKind" IN ('workspace', 'env')`);
  });
});
