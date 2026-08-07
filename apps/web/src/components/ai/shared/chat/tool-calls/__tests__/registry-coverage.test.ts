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
 * `pageSpaceTools`) by scanning for `<name>: tool({` declarations — in a plain
 * exported object literal or nested in a DI factory, both of which reach
 * `pageSpaceTools` via their `*-tools-runtime.ts` wrapper. This avoids
 * importing the server tool graph (db pool, dns, etc.) into a unit test while
 * still failing the moment a tool is added without a renderer.
 *
 * A tool is "covered" if it is registered in `toolRenderers` or listed in
 * `SPECIAL_HANDLED_TOOLS` (tools rendered as full-width cards outside the
 * registry, e.g. the task tools and ask_agent).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '../../../../../..', 'lib/ai/tools');

/**
 * Matches a tool declaration key: `<name>: tool(`, at any indent.
 *
 * Tools are declared in two shapes, both of which end up in `pageSpaceTools`:
 * directly inside an exported object literal (two-space indent), or inside a
 * dependency-injection factory — `createSessionTools`, `createSandboxTools`,
 * `createPagePaneTools` — whose `*-tools-runtime.ts` wrapper binds the deps and
 * folds the result into `pageSpaceTools` all the same. Pinning the scan to a
 * two-space indent made a formatting detail decide which tools exist, which
 * silently hid every factory-declared tool from the assertions below.
 */
const TOOL_KEY_RE = /^ {2,}([a-zA-Z_][a-zA-Z0-9_]*): tool\(/gm;

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

/**
 * Tools that ride `pageSpaceTools` today with no rich renderer yet.
 *
 * These are NOT an excuse list: they are the pre-existing gap the old
 * two-space-indent scan hid. Every entry here is declared inside a DI factory
 * (`createSessionTools` / `createSandboxTools`), so the scan never saw them and
 * the coverage assertion below passed vacuously for the whole session + shell
 * surface. Widening the scan makes them visible; recording them here keeps the
 * assertion enforcing on everything else while the renderers are designed.
 *
 * The two guards below keep the ledger honest in both directions: it cannot
 * grow SILENTLY — a new uncovered tool fails the coverage assertion until
 * someone adds it here deliberately, in a reviewable diff, with a reason — and
 * an entry that gains a renderer (or stops existing) must be deleted from here
 * or the test fails. Adding a line is a decision to defer a renderer, never a
 * way to make an unexpected failure go away.
 */
const PENDING_RICH_RENDERERS = new Set<string>([
  // session family (createSessionTools)
  'list_sessions',
  'spawn_session',
  'send_session',
  'read_session',
  'kill_session',
  'spawn_shell',
  'send_shell',
  'read_shell',
  'kill_shell',
  // pane-grid family (createSessionTools) — same surface, same gap: their
  // results are a grid geometry, and a rich card for one is a layout-diagram
  // design task rather than a payload reshuffle. Deferred with the rest of the
  // family so all of it lands as one coherent renderer set.
  'list_panes',
  'resize_pane',
  'move_pane',
  'arrange_panes',
  // sandbox file family (createSandboxTools); its `bash` shares the CLI renderer
  'writeFile',
  'readFile',
  'editFile',
]);

describe('tool renderer coverage', () => {
  const toolNames = collectToolNames();
  const covered = new Set<string>([...Object.keys(toolRenderers), ...SPECIAL_HANDLED_TOOLS]);

  it('scans the canonical tool definitions', () => {
    // Sanity: the scan found a realistic number of tools, so a path/regex
    // regression doesn't silently pass the coverage assertion below.
    expect(toolNames.length).toBeGreaterThan(80);
    expect(toolNames).toContain('create_page');
    expect(toolNames).toContain('list_calendar_events');
    // Shape pins: one tool from each declaration shape, so narrowing the regex
    // back to a single indent (and re-hiding the factory families) fails here
    // instead of silently shrinking the tool universe.
    expect(toolNames).toContain('spawn_session'); // createSessionTools factory
    expect(toolNames).toContain('open_page_pane'); // createPagePaneTools factory
    expect(toolNames).toContain('writeFile'); // createSandboxTools factory (camelCase key)
  });

  it('has a rich renderer for every AI tool', () => {
    const missing = toolNames.filter((name) => !covered.has(name) && !PENDING_RICH_RENDERERS.has(name));
    expect(
      missing,
      `Tools without a rich renderer: ${missing.join(', ')}.\n` +
        'Add an entry to toolRenderers in registry.tsx (or SPECIAL_HANDLED_TOOLS for full-card renderers).'
    ).toEqual([]);
  });

  it('keeps the pending-renderer ledger honest', () => {
    // An entry that gained a renderer, or that no longer names a real tool, is
    // stale: it must be deleted so the ledger can only ever shrink.
    const known = new Set(toolNames);
    const stale = [...PENDING_RICH_RENDERERS].filter((name) => covered.has(name) || !known.has(name)).sort();
    expect(
      stale,
      `PENDING_RICH_RENDERERS is stale for: ${stale.join(', ')}.\n` +
        'These tools now have a renderer (or no longer exist) — remove them from the ledger.'
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
