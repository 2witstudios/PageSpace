/**
 * Tool-surface parity gate vs pagespace-mcp v5.2.2 (Phase 6 task 2).
 *
 * This is the epic's honesty mechanism: it enumerates every tool
 * `pagespace-mcp` had at its v5.2.2 tag (`fixtures/v5.2.2-tools.json`, see
 * `fixtures/README.md` for exactly how that fixture was derived) and fails
 * loudly if the generated MCP surface (`buildOperationRegistry` +
 * `operationToMcpTool`, the same pipeline `pagespace mcp` serves over stdio)
 * is missing any of those tools or any of their v5.2.2-required input
 * fields. Renames/reshapes/drops are only permitted via the explicit,
 * commented map in `fixtures/v5.2.2-parity-map.ts` — never a silent skip.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listOperations } from '@pagespace/sdk';
import { buildOperationRegistry } from '../serve.js';
import { operationToMcpTool, type McpToolDefinition } from '../tool-convert.js';
import { DROPPED_TOOLS, TOOL_NAME_ALIASES, type FieldMapping } from './fixtures/v5.2.2-parity-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface V522Tool {
  readonly name: string;
  readonly required: readonly string[];
}

const fixtureTools: readonly V522Tool[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/v5.2.2-tools.json'), 'utf-8'),
);

const inventoryDoc = readFileSync(
  join(__dirname, '../../../../../docs/sdk/operations-inventory.md'),
  'utf-8',
);

function generatedSurface(): ReadonlyMap<string, McpToolDefinition & { readonly propertyNames: ReadonlySet<string> }> {
  const registry = buildOperationRegistry();
  const tools = listOperations(registry).map(operationToMcpTool);
  const byName = new Map<string, McpToolDefinition & { readonly propertyNames: ReadonlySet<string> }>();
  for (const tool of tools) {
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    byName.set(tool.name, { ...tool, propertyNames: new Set(Object.keys(properties)) });
  }
  return byName;
}

/** Resolves what property name(s) an old-tool required field should appear as in the new schema, or null if the field was intentionally dropped. */
function resolveExpectedField(fieldMapping: FieldMapping | undefined, oldField: string): string | null {
  const mapping = fieldMapping ?? { kind: 'same' as const };
  switch (mapping.kind) {
    case 'same':
      return oldField;
    case 'renamed':
      return mapping.to;
    case 'reshaped':
      return mapping.into;
    case 'dropped':
      return null;
  }
}

describe('v5.2.2 tool-surface parity gate', () => {
  it('fixture has exactly 67 tools, matching operations-inventory.md\'s stated count', () => {
    const match = inventoryDoc.match(/Tool count:\s*\*{0,2}(\d+)\s*registered tools/);
    expect(match, 'expected to find "Tool count: N registered tools" in operations-inventory.md').not.toBeNull();
    const inventoryCount = Number(match?.[1]);
    expect(
      fixtureTools.length,
      `fixture has ${fixtureTools.length} tools but operations-inventory.md declares ${inventoryCount} — name the delta before changing either`,
    ).toBe(inventoryCount);
  });

  it('every fixture tool is mapped in EXACTLY one of TOOL_NAME_ALIASES or DROPPED_TOOLS (total, disjoint partition)', () => {
    const unmapped: string[] = [];
    const mappedTwice: string[] = [];
    for (const tool of fixtureTools) {
      const inAliases = tool.name in TOOL_NAME_ALIASES;
      const inDropped = tool.name in DROPPED_TOOLS;
      if (!inAliases && !inDropped) unmapped.push(tool.name);
      if (inAliases && inDropped) mappedTwice.push(tool.name);
    }
    expect(unmapped, `v5.2.2 tools with no mapping at all — add each to TOOL_NAME_ALIASES or DROPPED_TOOLS: ${unmapped.join(', ')}`).toEqual([]);
    expect(mappedTwice, `v5.2.2 tools mapped in BOTH tables (ambiguous): ${mappedTwice.join(', ')}`).toEqual([]);
  });

  it('every DROPPED_TOOLS entry carries a non-empty reason', () => {
    for (const [name, entry] of Object.entries(DROPPED_TOOLS)) {
      expect(entry.reason.length, `DROPPED_TOOLS.${name} must have a reason string`).toBeGreaterThan(10);
    }
  });

  it('every aliased v5.2.2 tool has a live MCP tool at its mapped operation name', () => {
    const surface = generatedSurface();
    const missing: string[] = [];
    for (const tool of fixtureTools) {
      const mapping = TOOL_NAME_ALIASES[tool.name];
      if (!mapping) continue; // covered by the partition test above (dropped, or a real gap already failing there)
      if (!surface.has(mapping.opName)) {
        missing.push(`${tool.name} -> ${mapping.opName} (not found in generated MCP surface)`);
      }
    }
    expect(missing, `missing tools in the generated MCP surface:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every v5.2.2-required field of every aliased tool is present (by name or documented alias) in the generated schema', () => {
    const surface = generatedSurface();
    const problems: string[] = [];

    for (const tool of fixtureTools) {
      const mapping = TOOL_NAME_ALIASES[tool.name];
      if (!mapping) continue;

      const generated = surface.get(mapping.opName);
      if (!generated) continue; // already reported by the previous test

      for (const oldField of tool.required) {
        const expected = resolveExpectedField(mapping.fields?.[oldField], oldField);
        if (expected === null) continue; // explicitly, reason-documented drop

        if (!generated.propertyNames.has(expected)) {
          problems.push(
            `${tool.name}.${oldField} -> expected "${expected}" as a property of "${mapping.opName}", but it is absent. ` +
              `Generated properties: [${[...generated.propertyNames].join(', ')}]`,
          );
        }
      }
    }

    expect(problems, `required-field parity gaps:\n${problems.join('\n')}`).toEqual([]);
  });

  it('every DROPPED_TOOLS entry names a real, still-nonexistent gap (guards against a stale allowlist)', () => {
    const surface = generatedSurface();
    // None of these should coincidentally already exist under their own old
    // snake_case name or an obvious dotted equivalent — if one does, the
    // drop entry is stale and should move to TOOL_NAME_ALIASES instead.
    for (const name of Object.keys(DROPPED_TOOLS)) {
      expect(surface.has(name), `DROPPED_TOOLS.${name} exists verbatim in the generated surface — move it to TOOL_NAME_ALIASES`).toBe(false);
    }
  });
});
