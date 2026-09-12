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
  MAX_ADDRESSABLE_ROW,
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  MAX_DECIMALS,
  OP_FIELDS,
  FIELDS_BY_KIND,
  SCALE_ANCHOR_TYPES,
  parseConditionalRule,
  parseRegion,
} from '@pagespace/lib/sheets/sheet';
import type { ColumnRole, ConditionalOperator, ConditionalRule } from '@pagespace/lib/sheets/sheet';
// Type-only, so nothing from the store (and no database) is imported at
// runtime — these are the two result shapes the ROUTE spreads into its
// responses, and the only way to check the SDK against what it will actually
// receive rather than against a fixture written by the same hand.
import type { ApplyFormatOpsResult, TabFormatting } from '@pagespace/lib/sheets/store';
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

/**
 * The RESPONSE contract, which nothing else checks.
 *
 * Both sides of it are otherwise tested against fixtures written by the same
 * hand: the SDK's `outputSchema` against a literal in `sheets.test.ts`, and the
 * route against nothing. So a field the schema REQUIRES and the route never
 * sends would pass every test and then fail every real call with a
 * `ResponseValidationError` — the worst possible place to find out.
 *
 * `/api/mcp/sheets` answers `read-formatting` with `{pageId, pageTitle,
 * tabIndex, ...readTabFormatting(...)}` and `apply-format` with `{pageId,
 * pageTitle, tabIndex, changed, ...applyFormatOps(...)}`, so the keys the route
 * can possibly produce are exactly those three or four plus the keys of lib's
 * two result types. These assertions fail if the SDK ever requires one that is
 * not in that set.
 *
 * Key-level, not type-level, on purpose: `format` and `patch` payloads are
 * deliberately opaque here (`z.record`) where lib types them as `CellFormat`,
 * so a full structural comparison would fail on a difference that is intended.
 * What actually breaks in production is a MISSING key, and that is what this
 * catches.
 */
type RouteReadFormattingKeys = 'pageId' | 'pageTitle' | 'tabIndex' | keyof TabFormatting;
type RouteApplyFormatKeys = 'pageId' | 'pageTitle' | 'tabIndex' | 'changed' | keyof ApplyFormatOpsResult;

type SdkReadFormattingKeys = keyof z.infer<typeof readSheetFormatting.outputSchema>;
type SdkApplyFormatKeys = keyof z.infer<typeof applySheetFormat.outputSchema>;

const _readFormattingKeysAreSent: [SdkReadFormattingKeys] extends [RouteReadFormattingKeys] ? true : false = true;
const _applyFormatKeysAreSent: [SdkApplyFormatKeys] extends [RouteApplyFormatKeys] ? true : false = true;
void _readFormattingKeysAreSent;
void _applyFormatKeysAreSent;

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
const opsSchema = z.toJSONSchema(applySheetFormat.inputSchema, { io: 'input' }) as unknown as {
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

  it('accepts an unknown extension field, because lib hands one back', () => {
    // Not a guess about forward compatibility — the round trip is executed.
    // lib's parsers spread the stored value, so a field written by a newer
    // same-major server survives parsing; a strict schema here would reject
    // the whole `readFormatting` response and then refuse to write the rule
    // back, breaking exactly the read-modify-write these operations exist for.
    for (const [kind, base] of Object.entries(byKind)) {
      const stored = { ...base, futureField: { nested: 1 } };
      const parsed = parseConditionalRule(stored);
      expect(parsed, `lib dropped the ${kind} rule entirely`).not.toBeNull();
      // The premise: lib really does carry the unknown field through. If this
      // ever stops being true, the looseness below is no longer required and
      // this test should fail rather than quietly over-permit.
      expect((parsed as unknown as Record<string, unknown>).futureField, `lib stopped preserving unknown fields on a ${kind} rule`)
        .toEqual({ nested: 1 });
      // And the conclusion: what lib hands back, the SDK accepts.
      expect(accepts(parsed), `SDK rejected a ${kind} rule lib returned`).toBe(true);
    }
  });

  it('accepts an unknown extension field on a region and on a region column', () => {
    const stored = {
      id: 'g1',
      range: 'A1:F',
      headerRows: 1,
      columns: [{ column: 'C', role: 'currency', currency: 'USD', futureColumnField: 'x' }],
      futureRegionField: 'y',
    };
    const parsed = parseRegion(stored) as unknown as Record<string, unknown> | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.futureRegionField, 'lib stopped preserving unknown region fields').toBe('y');
    expect((parsed!.columns as unknown as Record<string, unknown>[])[0]!.futureColumnField, 'lib stopped preserving unknown column fields')
      .toBe('x');
    expect(
      applySheetFormat.inputSchema.safeParse({ pageId: 'p1', ops: [{ type: 'upsertRegion', region: parsed }] }).success,
      'SDK rejected a region lib returned',
    ).toBe(true);
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

  it('bounds a row-height row and a region total row at lib\'s DIFFERENT ceilings', () => {
    // `MAX_ADDRESSABLE_ROW` bounds a 0-BASED index (`decodeCellAddress`
    // returns `parseInt(rowPart) - 1`), and lib's two fields compare against
    // it differently: `setRowHeight` bounds `row - 1 > MAX_ADDRESSABLE_ROW`,
    // while `readTotalRows` filters `row <= MAX_ADDRESSABLE_ROW` with no
    // shift. So the last row that can take a HEIGHT is one past the last row
    // that can be marked a TOTAL. lib's own comment records this having been
    // got wrong once: comparing `row` to the constant directly "left the last
    // addressable row able to take a cell format but not a row height".
    // Pinned here because a single shared schema would have to be wrong for
    // one of them, and nothing else would notice.
    const height = (row: number) => accepts([{ type: 'setRowHeight', row, height: 32 }]);
    const total = (row: number) =>
      accepts([{ type: 'upsertRegion', region: { id: 'g', range: 'A1:F', totalRows: [row] } }]);

    expect(height(MAX_ADDRESSABLE_ROW + 1), 'last addressable row must take a height').toBe(true);
    expect(height(MAX_ADDRESSABLE_ROW + 2)).toBe(false);
    expect(height(0)).toBe(false);

    expect(total(MAX_ADDRESSABLE_ROW)).toBe(true);
    expect(total(MAX_ADDRESSABLE_ROW + 1), 'lib filters a total row past the constant').toBe(false);
    expect(total(0)).toBe(false);
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
