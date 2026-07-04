/**
 * Tool-surface parity gate vs pagespace-mcp v5.2.7 — the tool's deprecation
 * target and final release (Phase 6 task 2, re-pegged from the original
 * v5.2.2 gate). This is the epic's honesty mechanism: it enumerates every
 * tool `pagespace-mcp` had at its final 5.2.7 state
 * (`fixtures/v5.2.7-tools.json`, see `fixtures/README.md` for exactly how
 * that fixture was derived) and fails loudly if the generated MCP surface
 * (`buildOperationRegistry` + `operationToMcpTool`, the same pipeline
 * `pagespace mcp` serves over stdio) is missing any of those tools or any of
 * their v5.2.7-required input fields. Renames/reshapes/drops are only
 * permitted via the explicit, commented map in
 * `fixtures/v5.2.7-parity-map.ts` — never a silent skip.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listOperations } from '@pagespace/sdk';
import { buildOperationRegistry } from '../serve.js';
import { operationToMcpTool, type McpToolDefinition } from '../tool-convert.js';
import { DROPPED_TOOLS, TOOL_NAME_ALIASES, type FieldMapping } from './fixtures/v5.2.7-parity-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface V527Tool {
  readonly name: string;
  readonly required: readonly string[];
}

const fixtureTools: readonly V527Tool[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/v5.2.7-tools.json'), 'utf-8'),
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

describe('v5.2.7 tool-surface parity gate', () => {
  it('fixture has exactly 70 tools', () => {
    // Deliberately NOT cross-checked against docs/sdk/operations-inventory.md
    // here: that doc is frozen Phase 0 ground truth for the ORIGINAL v5.2.2
    // gate (67 tools) and is never updated for this re-peg. The v5.2.2 -> 70
    // delta (3 tools added, 2 tools gaining required fields) is documented in
    // fixtures/README.md instead.
    expect(
      fixtureTools.length,
      `fixture has ${fixtureTools.length} tools but the pinned pagespace-mcp v5.2.7 commit has 70 — see fixtures/README.md`,
    ).toBe(70);
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
    expect(unmapped, `v5.2.7 tools with no mapping at all — add each to TOOL_NAME_ALIASES or DROPPED_TOOLS: ${unmapped.join(', ')}`).toEqual([]);
    expect(mappedTwice, `v5.2.7 tools mapped in BOTH tables (ambiguous): ${mappedTwice.join(', ')}`).toEqual([]);
  });

  it('every DROPPED_TOOLS entry carries a non-empty reason', () => {
    for (const [name, entry] of Object.entries(DROPPED_TOOLS)) {
      expect(entry.reason.length, `DROPPED_TOOLS.${name} must have a reason string`).toBeGreaterThan(10);
    }
  });

  it('every aliased v5.2.7 tool has a live MCP tool at its mapped operation name', () => {
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

  it('every v5.2.7-required field of every aliased tool is present (by name or documented alias) in the generated schema', () => {
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
