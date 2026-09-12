/**
 * `applySheetFormat`'s op union is a HAND-WRITTEN copy of `SheetFormatOp` from
 * `@pagespace/lib/sheets`, because the published SDK must never runtime- or
 * type-import that package (a `.d.ts` referencing a subpath a consumer cannot
 * resolve breaks their `tsc` — see `operations/roles.ts` and
 * `operations/search.ts` for the same decision).
 *
 * A copy with nothing checking it is a copy that drifts, and the two ways it
 * drifts are both silent to a caller until a request fails:
 *
 *  - An op added to lib's union that is missing here is a capability the SDK
 *    cannot express at all — the failure that made this whole file necessary,
 *    one level up (the AI tools could format a sheet; the SDK could not).
 *  - A field renamed in lib is a request the server refuses as "not a field of
 *    this op", from an SDK that typechecked.
 *
 * `OP_FIELDS` exists in lib precisely so a test can enumerate the ops rather
 * than restate them, and its own doc says a new op has to be added there too.
 * This suite reads it, so a sixteenth op cannot join the union without failing
 * here. The lib import is test-only, from a devDependency — the same seam
 * `auth/__tests__/pkce-drift-guard.test.ts` uses.
 *
 * What is deliberately NOT compared: the `patch` / `format` payloads, which the
 * SDK keeps opaque (`z.record`). `CellFormat` already exists twice, held
 * together by a compile-time assertion those two share; a third copy here would
 * be the one with nothing keeping it honest, and would start refusing valid
 * requests the first time a format key is added. The server validates those
 * field by field and refuses an unknown key BY NAME, which is a better answer
 * than a local type error on a field that is in fact supported.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_CONDITIONAL_RULES,
  MAX_FORMAT_OPS,
  MAX_REGIONS,
  MAX_REGION_COLUMNS,
  MAX_REGION_HEADER_ROWS,
  MAX_REGION_TOTAL_ROWS,
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  MAX_DECIMALS,
  OP_FIELDS,
  FIELDS_BY_KIND,
  SCALE_ANCHOR_TYPES,
} from '@pagespace/lib/sheets/sheet';
import type { ColumnRole, ConditionalOperator, ConditionalRule } from '@pagespace/lib/sheets/sheet';
import { applySheetFormat, readSheetFormatting } from '../sheets.js';
import type { SheetConditionalRuleInput, SheetRegionInput } from '../sheets.js';

// ---------------------------------------------------------------------------
// Compile-time drift guards, for the unions JSON Schema cannot check both ways.
//
// A runtime sweep can only verify what lib exports as a value, and lib has no
// exhaustive list of conditional operators, rule kinds or column roles — only
// the TYPES. So these are asserted through mutual assignability: the pair below
// typechecks only when each union is a subset of the other, which fails for an
// operator lib adds and the SDK lacks AND for one the SDK invents.
//
// `bun run --filter @pagespace/sdk typecheck` is what runs these; vitest does
// not typecheck, so a `tsc` pass is required after editing this file.
// ---------------------------------------------------------------------------

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SdkCellRule = Extract<SheetConditionalRuleInput, { kind: 'cell' }>;
type SdkOperator = SdkCellRule['condition']['operator'];
type SdkRuleKind = SheetConditionalRuleInput['kind'];
type SdkColumnRole = NonNullable<SheetRegionInput['columns']>[number]['role'];

const _operatorsMatch: MutuallyAssignable<SdkOperator, ConditionalOperator> = true;
const _ruleKindsMatch: MutuallyAssignable<SdkRuleKind, ConditionalRule['kind']> = true;
const _columnRolesMatch: MutuallyAssignable<SdkColumnRole, ColumnRole> = true;
void _operatorsMatch;
void _ruleKindsMatch;
void _columnRolesMatch;

/**
 * The op union as JSON Schema, which is the only way to read the shapes back
 * out of a `z.discriminatedUnion` without exporting its internals. `io:
 * 'input'` because that is what a caller sends.
 */
const opsSchema = z.toJSONSchema(applySheetFormat.inputSchema, { io: 'input' }) as {
  properties: { ops: { items: { anyOf?: JsonSchemaObject[]; oneOf?: JsonSchemaObject[] } } };
};

interface JsonSchemaObject {
  properties?: Record<string, unknown>;
  required?: string[];
}

const variants = opsSchema.properties.ops.items.anyOf ?? opsSchema.properties.ops.items.oneOf ?? [];

/** Each variant keyed by its `type` const, with `type` itself dropped. */
const sdkOps = new Map<string, Set<string>>(
  variants.map((variant) => {
    const properties = variant.properties ?? {};
    const discriminant = properties.type as { const?: string } | undefined;
    const fields = new Set(Object.keys(properties));
    fields.delete('type');
    return [discriminant?.const ?? '(no type const)', fields] as const;
  }),
);

describe('applySheetFormat op union — drift guard vs @pagespace/lib SheetFormatOp', () => {
  it('covers every op in lib\'s union, and invents none', () => {
    expect([...sdkOps.keys()].sort()).toEqual(Object.keys(OP_FIELDS).sort());
  });

  it('takes exactly the fields lib\'s OP_FIELDS allows, op by op', () => {
    // Not a subset check on either side. A missing field is a capability the
    // SDK cannot express; an extra one is a request the server refuses as
    // '"x" is not a field of this op' from an SDK that typechecked.
    for (const [type, allowed] of Object.entries(OP_FIELDS)) {
      expect([...(sdkOps.get(type) ?? [])].sort(), `op "${type}"`).toEqual([...allowed].sort());
    }
  });

  it('requires the op fields lib treats as mandatory', () => {
    // `setFrozen` is the one op where both fields are optional — lib refuses
    // the both-omitted case in `planFormatOps` rather than in a shape check,
    // and the SDK mirrors that with a refinement JSON Schema cannot express.
    const requiredByType = new Map(
      variants.map((variant) => [
        (variant.properties?.type as { const?: string } | undefined)?.const ?? '',
        new Set((variant.required ?? []).filter((field) => field !== 'type')),
      ]),
    );
    expect(requiredByType.get('setCellFormat')).toEqual(new Set(['range', 'patch']));
    expect(requiredByType.get('setColumnWidth')).toEqual(new Set(['column', 'width']));
    expect(requiredByType.get('setRowHeight')).toEqual(new Set(['row', 'height']));
    expect(requiredByType.get('setFrozen')).toEqual(new Set());
    expect(requiredByType.get('clearConditionalRules')).toEqual(new Set());
    expect(
      applySheetFormat.inputSchema.safeParse({ pageId: 'p1', ops: [{ type: 'setFrozen' }] }).success,
    ).toBe(false);
  });
});

describe('conditional rule shapes — drift guard vs @pagespace/lib', () => {
  const accepts = (rule: unknown): boolean =>
    applySheetFormat.inputSchema.safeParse({ pageId: 'p1', ops: [{ type: 'addConditionalRule', rule }] }).success;

  /** A minimal valid rule of each kind, for mutating one field at a time. */
  const byKind: Record<string, Record<string, unknown>> = {
    cell: { kind: 'cell', id: 'r', ranges: ['A1'], condition: { operator: 'isEmpty' }, format: { bold: true } },
    formula: { kind: 'formula', id: 'r', ranges: ['A1'], formula: '=A1>0', format: { bold: true } },
    colorScale: { kind: 'colorScale', id: 'r', ranges: ['A1'], min: { type: 'min', color: '#ffffff' }, max: { type: 'max', color: '#000000' } },
    dataBar: { kind: 'dataBar', id: 'r', ranges: ['A1'], color: '#1d4ed8' },
  };

  it('accepts, for each kind, exactly the fields lib\'s FIELDS_BY_KIND reads', () => {
    // `FIELDS_BY_KIND` is lib's single copy of this answer, checked there
    // against the evaluator. A field the SDK omits is a rule a caller cannot
    // express; a field foreign to the kind is one lib refuses by name.
    const foreignByKind = Object.fromEntries(
      Object.entries(FIELDS_BY_KIND).map(([kind, fields]) => [
        kind,
        [...new Set(Object.values(FIELDS_BY_KIND).flat())].filter((field) => !fields.includes(field)),
      ]),
    );
    for (const [kind, fields] of Object.entries(FIELDS_BY_KIND)) {
      const base = byKind[kind];
      expect(base, `no fixture for rule kind "${kind}"`).toBeDefined();
      expect(accepts(base!), `base ${kind} rule`).toBe(true);
      // Every field of this kind is one the SDK knows: dropping it either
      // fails (required) or parses (optional), but SETTING it never fails.
      for (const field of fields) {
        expect(accepts({ ...base!, [field]: base![field] ?? { type: 'min' } }), `${kind}.${field}`).toBe(true);
      }
      // Every field belonging only to another kind is refused, not stripped.
      for (const foreign of foreignByKind[kind]!) {
        expect(accepts({ ...base!, [foreign]: base!['format'] ?? '#000000' }), `${kind} must refuse "${foreign}"`).toBe(false);
      }
    }
  });

  it('accepts exactly lib\'s scale anchor types', () => {
    for (const type of SCALE_ANCHOR_TYPES) {
      const anchor = type === 'min' || type === 'max' ? { type, color: '#ffffff' } : { type, value: 5, color: '#ffffff' };
      expect(accepts({ ...byKind.colorScale, min: anchor }), `anchor "${type}"`).toBe(true);
    }
    expect(accepts({ ...byKind.colorScale, min: { type: 'median', color: '#ffffff' } })).toBe(false);
  });
});

describe('inlined caps — drift guard vs @pagespace/lib', () => {
  /** The largest value each cap still accepts, found by bisecting the schema. */
  const accepts = (ops: unknown[]): boolean =>
    applySheetFormat.inputSchema.safeParse({ pageId: 'p1', ops }).success;

  it('bounds the op list at lib\'s MAX_FORMAT_OPS', () => {
    const op = { type: 'clearCellFormat', range: 'A1' };
    expect(accepts(Array.from({ length: MAX_FORMAT_OPS }, () => op))).toBe(true);
    expect(accepts(Array.from({ length: MAX_FORMAT_OPS + 1 }, () => op))).toBe(false);
  });

  it('bounds ranges on readFormatting at the same ceiling lib reads at', () => {
    const ok = readSheetFormatting.inputSchema.safeParse({
      pageId: 'p1', ranges: Array.from({ length: MAX_FORMAT_OPS }, () => 'A1'),
    });
    const tooMany = readSheetFormatting.inputSchema.safeParse({
      pageId: 'p1', ranges: Array.from({ length: MAX_FORMAT_OPS + 1 }, () => 'A1'),
    });
    expect([ok.success, tooMany.success]).toEqual([true, false]);
  });

  it('bounds the rule list at lib\'s MAX_CONDITIONAL_RULES', () => {
    const rule = { kind: 'cell', id: 'r', ranges: ['A1'], condition: { operator: 'isEmpty' }, format: { bold: true } };
    expect(accepts([{ type: 'setConditionalRules', rules: Array.from({ length: MAX_CONDITIONAL_RULES }, () => rule) }])).toBe(true);
    expect(accepts([{ type: 'setConditionalRules', rules: Array.from({ length: MAX_CONDITIONAL_RULES + 1 }, () => rule) }])).toBe(false);
  });

  it('bounds regions, their columns, total rows and header rows at lib\'s limits', () => {
    const region = { id: 'g', range: 'A1:F' };
    expect(accepts([{ type: 'setRegions', regions: Array.from({ length: MAX_REGIONS }, () => region) }])).toBe(true);
    expect(accepts([{ type: 'setRegions', regions: Array.from({ length: MAX_REGIONS + 1 }, () => region) }])).toBe(false);

    const column = { column: 'A', role: 'text' as const };
    expect(accepts([{ type: 'upsertRegion', region: { ...region, columns: Array.from({ length: MAX_REGION_COLUMNS }, () => column) } }])).toBe(true);
    expect(accepts([{ type: 'upsertRegion', region: { ...region, columns: Array.from({ length: MAX_REGION_COLUMNS + 1 }, () => column) } }])).toBe(false);

    expect(accepts([{ type: 'upsertRegion', region: { ...region, totalRows: Array.from({ length: MAX_REGION_TOTAL_ROWS }, () => 1) } }])).toBe(true);
    expect(accepts([{ type: 'upsertRegion', region: { ...region, totalRows: Array.from({ length: MAX_REGION_TOTAL_ROWS + 1 }, () => 1) } }])).toBe(false);

    expect(accepts([{ type: 'upsertRegion', region: { ...region, headerRows: MAX_REGION_HEADER_ROWS } }])).toBe(true);
    expect(accepts([{ type: 'upsertRegion', region: { ...region, headerRows: MAX_REGION_HEADER_ROWS + 1 } }])).toBe(false);

    expect(accepts([{ type: 'upsertRegion', region: { ...region, columns: [{ ...column, decimals: MAX_DECIMALS }] } }])).toBe(true);
    expect(accepts([{ type: 'upsertRegion', region: { ...region, columns: [{ ...column, decimals: MAX_DECIMALS + 1 }] } }])).toBe(false);
  });

  it('bounds column widths and row heights at lib\'s min and max', () => {
    for (const [width, expected] of [
      [MIN_COLUMN_WIDTH, true], [MIN_COLUMN_WIDTH - 1, false],
      [MAX_COLUMN_WIDTH, true], [MAX_COLUMN_WIDTH + 1, false],
    ] as const) {
      expect(accepts([{ type: 'setColumnWidth', column: 'A', width }]), `width ${width}`).toBe(expected);
    }
    for (const [height, expected] of [
      [MIN_ROW_HEIGHT, true], [MIN_ROW_HEIGHT - 1, false],
      [MAX_ROW_HEIGHT, true], [MAX_ROW_HEIGHT + 1, false],
    ] as const) {
      expect(accepts([{ type: 'setRowHeight', row: 1, height }]), `height ${height}`).toBe(expected);
    }
  });
});
