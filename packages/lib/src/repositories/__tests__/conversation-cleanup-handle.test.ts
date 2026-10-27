/**
 * `conversation-cleanup.ts`'s two deletes — the messages and the conversation
 * shells that own them — must land in ONE transaction. Its header has always
 * said so ("Call inside the same transaction as the delete it accompanies"),
 * and all five callers comply.
 *
 * Nothing enforced it. `DbHandle` aliased `typeof db`, so a sixth caller
 * passing the module handle would have compiled cleanly and split the pair,
 * leaving the conversation shells behind if the second statement failed.
 *
 * This is a TYPE test: there is no runtime behaviour to assert, only that the
 * compiler now refuses the module handle. If drizzle's transaction type ever
 * becomes structurally assignable from `NodePgDatabase`, the `@ts-expect-error`
 * below goes unused and this fails — which is the alarm we want, because at
 * that point the guarantee has quietly evaporated.
 */
import { describe, it, expect } from 'vitest';
import { db } from '@pagespace/db/db';
import type { DbHandle } from '../conversation-cleanup';

describe('conversation cleanup requires a transaction handle', () => {
  it('rejects the module db handle at compile time', () => {
    // @ts-expect-error the module `db` is not a transaction handle
    const notATransaction: DbHandle = db;
    void notATransaction;

    // A transaction handle is what the callers actually pass; typing the
    // parameter is the whole assertion, so there is nothing else to check.
    expect(typeof db.transaction).toBe('function');
  });
});
