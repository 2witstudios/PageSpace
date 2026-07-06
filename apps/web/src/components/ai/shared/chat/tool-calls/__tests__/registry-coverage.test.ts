import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { toolRenderers, SPECIAL_HANDLED_TOOLS, CLI_TOOL_NAMES } from '../registry';
import { DIFF_TOOL_NAMES } from '../tool-significance';

/**
 * Coverage guard: every AI tool must have a rich renderer.
 *
 * We derive the authoritative tool list straight from the tool definition files
 * in `apps/web/src/lib/ai/tools/*-tools.ts` (the same modules assembled into
 * `pageSpaceTools`) by scanning for top-level `<name>: tool({` declarations.
 * This avoids importing the server tool graph (db pool, dns, etc.) into a unit
 * test while still failing the moment a tool is added without a renderer.
 *
 * A tool is "covered" if it is registered in `toolRenderers` or listed in
 * `SPECIAL_HANDLED_TOOLS` (tools rendered as full-width cards outside the
 * registry, e.g. the task tools and ask_agent).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '../../../../../..', 'lib/ai/tools');

// Matches a top-level tool declaration: two-space indent, snake_case key, `: tool(`.
const TOOL_KEY_RE = /^ {2}([a-z_]+): tool\(/gm;

function collectToolNames(): string[] {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('-tools.ts'));
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    for (const match of source.matchAll(TOOL_KEY_RE)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('tool renderer coverage', () => {
  const toolNames = collectToolNames();
  const covered = new Set<string>([...Object.keys(toolRenderers), ...SPECIAL_HANDLED_TOOLS]);

  it('scans the canonical tool definitions', () => {
    // Sanity: the scan found a realistic number of tools, so a path/regex
    // regression doesn't silently pass the coverage assertion below.
    expect(toolNames.length).toBeGreaterThan(40);
    expect(toolNames).toContain('create_page');
    expect(toolNames).toContain('list_calendar_events');
  });

  it('has a rich renderer for every AI tool', () => {
    const missing = toolNames.filter((name) => !covered.has(name));
    expect(
      missing,
      `Tools without a rich renderer: ${missing.join(', ')}.\n` +
        'Add an entry to toolRenderers in registry.tsx (or SPECIAL_HANDLED_TOOLS for full-card renderers).'
    ).toEqual([]);
  });

  it('does not register renderers for unknown tools', () => {
    // Guards against typos / stale entries drifting from the real tool set.
    // CLI_TOOL_NAMES entries are intentional client-side renderers (pi / pagespace-cli)
    // and are not in the PageSpace server tool set.
    const known = new Set(toolNames);
    const cliToolSet = new Set<string>(CLI_TOOL_NAMES);
    const orphanRegistry = Object.keys(toolRenderers).filter((name) => !known.has(name) && !cliToolSet.has(name));
    expect(orphanRegistry, `Registry entries for non-existent tools: ${orphanRegistry.join(', ')}`).toEqual([]);
  });
});

/**
 * Cross-check: tool-significance.ts's DIFF_TOOL_NAMES documents itself as the
 * "single source of truth" for which tools always render a diff (and are
 * therefore never folded into a ToolRunGroup) — but nothing imports it into
 * registry.tsx, so the claim was previously unenforced. This scans
 * registry.tsx's own source so the two can't silently drift apart: adding a
 * tool to DIFF_TOOL_NAMES without wiring RichDiffRenderer (or vice versa)
 * fails this test.
 */
describe('DIFF_TOOL_NAMES <-> RichDiffRenderer cross-check', () => {
  const registrySourcePath = path.resolve(__dirname, '../registry.tsx');
  const registrySource = readFileSync(registrySourcePath, 'utf8');

  function extractRendererBody(toolName: string): string | null {
    const lines = registrySource.split('\n');
    const keyLineRe = new RegExp(`^ {2}${toolName}: `);
    const startIdx = lines.findIndex((line) => keyLineRe.test(line));
    if (startIdx === -1) return null;

    const nextKeyOrEndRe = /^ {2}[a-zA-Z_]+: |^\};/;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (nextKeyOrEndRe.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    return lines.slice(startIdx, endIdx).join('\n');
  }

  it('every DIFF_TOOL_NAMES entry has a registry.tsx renderer that uses RichDiffRenderer', () => {
    const missing = [...DIFF_TOOL_NAMES].filter((name) => {
      const body = extractRendererBody(name);
      return !body || !body.includes('RichDiffRenderer');
    });
    expect(
      missing,
      `DIFF_TOOL_NAMES (tool-significance.ts) claims these tools always render a diff, ` +
        `but their registry.tsx renderer doesn't reference RichDiffRenderer: ${missing.join(', ')}.\n` +
        'Either wire up RichDiffRenderer for them in registry.tsx, or remove them from DIFF_TOOL_NAMES.'
    ).toEqual([]);
  });
});
