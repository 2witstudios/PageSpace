/**
 * The sheet operations must reach agents over MCP, not just the CLI.
 *
 * `ALL_OPERATIONS` in `serve.ts` is hand-maintained and nothing diffs it
 * against the SDK's exports, so an operation added to the SDK is silently
 * absent from the MCP surface — which is where agents actually call from. That
 * is how the six row operations shipped reachable from a terminal and invisible
 * to an agent, while `edit_sheet_cells` (the older, document-shaped verb) was
 * present. The two formatting operations are swept here for the same reason.
 */
import { describe, expect, it } from 'vitest';
import { listOperations } from '@pagespace/sdk';
import { buildOperationRegistry } from '../serve.js';
import { operationToMcpTool } from '../tool-convert.js';

const tools = listOperations(buildOperationRegistry()).map((op) => operationToMcpTool(op));
const byName = new Map(tools.map((tool) => [tool.name, tool]));

describe('sheet row operations on the MCP surface', () => {
  it('exposes every row operation as a tool', () => {
    for (const name of [
      'sheets.queryRows',
      'sheets.getRows',
      'sheets.describe',
      'sheets.appendRows',
      'sheets.updateCells',
      'sheets.deleteRows',
    ]) {
      expect(byName.has(name), `${name} missing from the MCP tool surface`).toBe(true);
      expect(byName.get(name)!.description.length).toBeGreaterThan(0);
    }
  });

  it('flags deleteRows destructive, and nothing else here', () => {
    // The annotation an agent frontend reads to decide whether to ask first.
    expect(byName.get('sheets.deleteRows')!.annotations.destructiveHint).toBe(true);
    for (const name of [
      'sheets.queryRows', 'sheets.getRows', 'sheets.describe', 'sheets.appendRows', 'sheets.updateCells',
      // Formatting is presentation, recoverable by writing it again — unlike
      // rows, which are gone.
      'sheets.readFormatting', 'sheets.applyFormat',
    ]) {
      expect(byName.get(name)!.annotations.destructiveHint, `${name} should not be destructive`).toBe(false);
    }
  });

  it('exposes the formatting operations too, so an agent has the surface the in-process tools have', () => {
    // The gap this file's header describes, one layer up: `format_sheet` and
    // `set_conditional_format` were reachable in-process while nothing over
    // MCP could style a sheet at all.
    for (const name of ['sheets.readFormatting', 'sheets.applyFormat']) {
      expect(byName.has(name), `${name} missing from the MCP tool surface`).toBe(true);
      expect(byName.get(name)!.description.length).toBeGreaterThan(0);
    }
  });

  it('converts the format op union to JSON Schema an agent can read', () => {
    // A `z.discriminatedUnion` of fifteen members renders as anyOf/oneOf. If
    // tool-convert dropped it, an agent would see `ops` as an array of
    // anything and learn the op names one refusal at a time.
    const schema = byName.get('sheets.applyFormat')!.inputSchema as unknown as {
      properties?: Record<string, { items?: { anyOf?: unknown[]; oneOf?: unknown[] } }>;
    };
    const items = schema.properties?.ops?.items;
    const variants = items?.anyOf ?? items?.oneOf;
    expect(variants).toBeDefined();
    expect(variants!.length).toBe(15);
    // The op names have to be visible in the serialised schema, not just the
    // shapes: they are what an agent writes into `type`.
    const serialised = JSON.stringify(schema);
    for (const type of ['upsertRegion', 'setCellFormat', 'addConditionalRule', 'setFrozen', 'setColumnWidth']) {
      expect(serialised, `op "${type}" is not visible in the tool schema`).toContain(type);
    }
  });

  it('converts the recursive where filter to valid JSON Schema', () => {
    // `where` is a z.lazy union, which is not among the constructs
    // tool-convert's header claims to have verified. zod emits it as a $ref
    // into $defs; an empty or missing schema here would leave an agent unable
    // to see that filtering exists at all.
    const schema = byName.get('sheets.queryRows')!.inputSchema as unknown as {
      properties?: Record<string, unknown>;
      $defs?: Record<string, unknown>;
    };
    expect(schema.properties?.where).toBeDefined();
    expect(schema.$defs).toBeDefined();
    expect(Object.keys(schema.$defs!).length).toBeGreaterThan(0);
  });

  it('describe takes only a pageId — no tabIndex to make discovery fail', () => {
    const schema = byName.get('sheets.describe')!.inputSchema as unknown as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['operation', 'pageId']);
  });
});
