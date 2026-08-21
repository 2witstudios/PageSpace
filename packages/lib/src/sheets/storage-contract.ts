/**
 * @module @pagespace/lib/sheets/storage-contract
 * @description Compile-time guard that the persisted cell shape and the
 * in-memory one have not drifted apart.
 *
 * `CellFormat` is defined twice — once here in `@pagespace/lib/sheets/types` as
 * the shape the engine works with, and once in `@pagespace/db` as the shape of
 * the `jsonb` columns. The duplication is forced: `lib` depends on `db`, so `db`
 * cannot import from `lib`, and the column types have to live with the columns.
 *
 * Nothing in this module runs. It exists so that adding a field to one
 * definition and not the other is a type error at build time rather than a
 * value silently dropped on write, which is how formatting would quietly stop
 * round-tripping.
 */

import type { CellFormat as DbCellFormat } from '@pagespace/db/schema';
import type { CellFormat as LibCellFormat } from './types';

/** Fails to compile unless `A` and `B` are the same type in both directions. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * If this line errors, the two `CellFormat` definitions have diverged: reconcile
 * `packages/db/src/schema/sheets-types.ts` with
 * `packages/lib/src/sheets/types.ts` rather than casting the error away.
 */
export type CellFormatContractHolds = MutuallyAssignable<DbCellFormat, LibCellFormat>;

const _cellFormatContract: CellFormatContractHolds = true;
void _cellFormatContract;
