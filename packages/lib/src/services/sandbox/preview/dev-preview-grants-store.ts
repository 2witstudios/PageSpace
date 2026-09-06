/**
 * `dev_preview_grants` store — mint and CONSUME (exactly once).
 *
 * `consume` is one conditional `UPDATE … RETURNING`: it stamps `consumedAt`
 * only where it is still NULL and the grant has not expired, and returns the
 * row it stamped. Two racing redemptions of the same id contend on the row
 * lock; the second finds `consumedAt` set and updates nothing. That is the
 * whole single-use guarantee, and it holds across replicas because it lives
 * in the database (the table docblock).
 *
 * Time is passed in (`now`) rather than read from the database: the columns
 * are UTC wall-clock timestamps and `now()` resolves through the session
 * time zone — the standing SQL-now rule.
 */

import { randomBytes } from 'node:crypto';
import { db } from '@pagespace/db/db';
import { and, eq, isNull, gt, lt } from '@pagespace/db/operators';
import { devPreviewGrants } from '@pagespace/db/schema/dev-preview-grants';
import type { DevPreviewHolderRef } from './dev-preview-core';
import { PREVIEW_COOKIE_TTL_MS, PREVIEW_GRANT_TTL_MS } from './preview-grant';

export interface MintedPreviewGrant {
  id: string;
  expiresAt: Date;
  cookieExpiresAt: Date;
}

export interface ConsumedPreviewGrant {
  holder: DevPreviewHolderRef;
  userId: string;
  cookieExpiresAt: Date;
}

export interface DevPreviewGrantsStore {
  mint(input: { holder: DevPreviewHolderRef; userId: string; now: Date }): Promise<MintedPreviewGrant>;
  /** The grant's claims if THIS call redeemed it; null if it does not exist, is expired, or was already redeemed. */
  consume(input: { id: string; now: Date }): Promise<ConsumedPreviewGrant | null>;
}

/** 256 bits; the id IS the capability, so it must be unguessable. */
export function generatePreviewGrantId(): string {
  return randomBytes(32).toString('base64url');
}

/** Grants older than this past their expiry are swept on the next mint. */
const SWEEP_GRACE_MS = 60 * 60 * 1000;

const GRANT_ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function createDbDevPreviewGrantsStore(): DevPreviewGrantsStore {
  return {
    async mint({ holder, userId, now }) {
      const id = generatePreviewGrantId();
      const expiresAt = new Date(now.getTime() + PREVIEW_GRANT_TTL_MS);
      const cookieExpiresAt = new Date(now.getTime() + PREVIEW_COOKIE_TTL_MS);
      await db.insert(devPreviewGrants).values({
        id,
        holderKind: holder.kind,
        holderId: holder.id,
        userId,
        expiresAt,
        cookieExpiresAt,
        createdAt: now,
      });
      // Opportunistic, bounded-by-predicate sweep: nothing here is needed
      // after its redemption window, and a failed sweep must not fail a mint.
      try {
        await db.delete(devPreviewGrants).where(lt(devPreviewGrants.expiresAt, new Date(now.getTime() - SWEEP_GRACE_MS)));
      } catch {
        // Swept on the next mint instead.
      }
      return { id, expiresAt, cookieExpiresAt };
    },

    async consume({ id, now }) {
      // Shape-check before the query: the id arrives from a query string, and
      // a malformed one cannot match a row, so it never needs to reach SQL.
      if (!GRANT_ID_SHAPE.test(id)) return null;
      const [row] = await db
        .update(devPreviewGrants)
        .set({ consumedAt: now })
        .where(and(eq(devPreviewGrants.id, id), isNull(devPreviewGrants.consumedAt), gt(devPreviewGrants.expiresAt, now)))
        .returning({
          holderKind: devPreviewGrants.holderKind,
          holderId: devPreviewGrants.holderId,
          userId: devPreviewGrants.userId,
          cookieExpiresAt: devPreviewGrants.cookieExpiresAt,
        });
      if (!row) return null;
      const kind = row.holderKind === 'workspace' ? 'workspace' : 'env';
      return { holder: { kind, id: row.holderId }, userId: row.userId, cookieExpiresAt: row.cookieExpiresAt };
    },
  };
}
