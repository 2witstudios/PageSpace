/**
 * Tests for apps/web/src/lib/ai/core/inline-instructions.ts
 *
 * Covers:
 * - buildInlineInstructions: always-on sections, tool-gated sections
 * - Tool-gating: TASK_MANAGEMENT, AGENTS, AUTOMATION, SEARCH presence/absence
 * - availableTools=undefined sentinel (include all — backward compat for admin viewer)
 * - availableTools=[] (no tools — only always-on sections)
 *
 * Location/drive/page context ("CONTEXT" interpolation) used to live here but
 * was moved to location-prompt.ts (see location-prompt.test.ts) so it can be
 * injected via the volatile turn-context block instead of baked into this
 * stable, tool-list-only instructions block.
 */

import { describe, it, expect } from 'vitest';
import {
  buildGlobalAssistantInstructions,
  buildInlineInstructions,
} from '../inline-instructions';

describe('buildInlineInstructions — always-on sections', () => {
  it('includes WORKSPACE RULES regardless of tool list', () => {
    const result = buildInlineInstructions([]);
    expect(result).toContain('WORKSPACE RULES');
  });

  it('includes PAGE TYPES regardless of tool list', () => {
    const result = buildInlineInstructions([]);
    expect(result).toContain('PAGE TYPES');
  });

  it('instructs canvas authors to use dashboard file view URLs for embedded uploaded files', () => {
    const result = buildInlineInstructions([]);
    expect(result).toContain('/dashboard/{driveId}/{filePageId}/view');
    expect(result).toContain('not /api/files');
  });

  it('includes AFTER TOOLS regardless of tool list', () => {
    const result = buildInlineInstructions([]);
    expect(result).toContain('AFTER TOOLS');
  });

  it('includes MENTIONS regardless of tool list', () => {
    const result = buildInlineInstructions([]);
    expect(result).toContain('MENTIONS');
  });

  it('does not include location-specific CONTEXT text — that is volatile, injected separately', () => {
    const result = buildInlineInstructions([]);
    expect(result).not.toContain('Current location:');
  });
});

describe('buildInlineInstructions — TASK_MANAGEMENT gating', () => {
  it('includes TASK MANAGEMENT when create_task is available', () => {
    const result = buildInlineInstructions(['create_task']);
    expect(result).toContain('TASK MANAGEMENT');
  });

  it('includes TASK MANAGEMENT when update_task is available', () => {
    const result = buildInlineInstructions(['update_task']);
    expect(result).toContain('TASK MANAGEMENT');
  });

  it('includes TASK MANAGEMENT when any task tool is available', () => {
    for (const tool of ['delete_task', 'create_task_status', 'reorder_task', 'get_assigned_tasks']) {
      const result = buildInlineInstructions([tool]);
      expect(result).toContain('TASK MANAGEMENT');
    }
  });

  it('excludes TASK MANAGEMENT when no task tools are available', () => {
    const result = buildInlineInstructions(['read_page', 'list_pages']);
    expect(result).not.toContain('TASK MANAGEMENT');
  });
});

describe('buildInlineInstructions — AGENTS gating', () => {
  it('includes AGENTS when spawn_session is available', () => {
    const result = buildInlineInstructions(['spawn_session']);
    expect(result).toContain('AGENTS');
  });

  it('includes AGENTS when list_agents is available', () => {
    const result = buildInlineInstructions(['list_agents']);
    expect(result).toContain('AGENTS');
  });

  it('includes AGENTS when any agent tool is available', () => {
    for (const tool of ['multi_drive_list_agents', 'update_agent_config', 'list_models']) {
      const result = buildInlineInstructions([tool]);
      expect(result).toContain('AGENTS');
    }
  });

  it('excludes AGENTS when no agent tools are available', () => {
    const result = buildInlineInstructions(['read_page', 'create_task']);
    expect(result).not.toContain('AGENTS');
  });
});

describe('buildInlineInstructions — AUTOMATION gating', () => {
  it('includes AUTOMATION when set_task_trigger is available', () => {
    const result = buildInlineInstructions(['set_task_trigger']);
    expect(result).toContain('AUTOMATION');
  });

  it('includes AUTOMATION when any trigger/workflow tool is available', () => {
    for (const tool of ['delete_task_trigger', 'set_calendar_trigger', 'delete_calendar_trigger', 'create_workflow', 'list_workflows']) {
      const result = buildInlineInstructions([tool]);
      expect(result).toContain('AUTOMATION');
    }
  });

  it('excludes AUTOMATION when no trigger or workflow tools are available', () => {
    const result = buildInlineInstructions(['create_task', 'ask_agent']);
    expect(result).not.toContain('AUTOMATION');
  });
});

describe('buildInlineInstructions — SEARCH gating', () => {
  it('includes SEARCH when glob_search is available', () => {
    const result = buildInlineInstructions(['glob_search']);
    expect(result).toContain('SEARCH');
  });

  it('includes SEARCH when any search tool is available', () => {
    for (const tool of ['regex_search', 'multi_drive_search', 'web_search', 'web_fetch']) {
      const result = buildInlineInstructions([tool]);
      expect(result).toContain('SEARCH');
    }
  });

  it('excludes SEARCH when no search tools are available', () => {
    const result = buildInlineInstructions(['read_page', 'create_task']);
    expect(result).not.toContain('SEARCH');
  });
});

describe('buildInlineInstructions — availableTools=undefined sentinel', () => {
  it('includes all sections when availableTools is omitted', () => {
    const result = buildInlineInstructions();
    expect(result).toContain('TASK MANAGEMENT');
    expect(result).toContain('AGENTS');
    expect(result).toContain('AUTOMATION');
    expect(result).toContain('SEARCH');
  });

  it('includes all sections when availableTools is explicitly undefined', () => {
    const result = buildInlineInstructions(undefined);
    expect(result).toContain('TASK MANAGEMENT');
    expect(result).toContain('AGENTS');
    expect(result).toContain('AUTOMATION');
    expect(result).toContain('SEARCH');
  });
});

describe('buildInlineInstructions — full tool set', () => {
  it('includes all gated sections when all relevant tools are provided', () => {
    const result = buildInlineInstructions([
      'create_task', 'spawn_session', 'set_task_trigger', 'glob_search',
    ]);
    expect(result).toContain('TASK MANAGEMENT');
    expect(result).toContain('AGENTS');
    expect(result).toContain('AUTOMATION');
    expect(result).toContain('SEARCH');
  });

  it('returns a non-empty string', () => {
    const result = buildInlineInstructions([]);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('buildInlineInstructions — skill-aware slimming', () => {
  const ALL_SKILL_TOOLS = [
    'load_skill',
    'create_page',
    'replace_lines',
    'insert_content',
    'edit_sheet_cells',
    'create_task',
    'update_task',
  ];

  it('slims PAGE TYPES to skill pointers when load_skill and the skills are eligible', () => {
    const result = buildInlineInstructions(ALL_SKILL_TOOLS);
    expect(result).toContain('Load the canvas-websites skill');
    expect(result).toContain('Load the writing-documents skill');
    expect(result).toContain('load the spreadsheets skill');
    // The deep canvas conventions moved into the skill body
    expect(result).not.toContain('provision_form_target');
  });

  it('slims per bullet: an ineligible skill keeps its FULL bullet', () => {
    // Sheets eligible; canvas/writing not (no create_page/replace_lines).
    const result = buildInlineInstructions(['load_skill', 'edit_sheet_cells', 'read_page']);
    expect(result).toContain('load the spreadsheets skill');
    // Canvas bullet stays full — pointer would target a skill the catalog omits
    expect(result).toContain('provision_form_target');
    expect(result).not.toContain('Load the canvas-websites skill');
  });

  it('keeps the full PAGE TYPES fallback when load_skill is absent', () => {
    const result = buildInlineInstructions(['create_task']);
    expect(result).toContain('provision_form_target');
    expect(result).not.toContain('Load the canvas-websites skill');
  });

  it('keeps the full text for the undefined sentinel (admin complete preview)', () => {
    const result = buildInlineInstructions();
    expect(result).toContain('provision_form_target');
    expect(result).not.toContain('Load the canvas-websites skill');
  });

  it('slims TASK MANAGEMENT but keeps the predictably-wrong bullets', () => {
    const result = buildInlineInstructions(ALL_SKILL_TOOLS);
    expect(result).toContain('Read the task list with read_page before any mutations');
    expect(result).toContain("a parent can't complete while direct subtasks remain open");
    expect(result).toContain('Load the task-management skill');
    expect(result).not.toContain('only call create_task_status when no existing status fits');
  });

  it('buildGlobalAssistantInstructions slims with eligible tools and stays full without', () => {
    expect(buildGlobalAssistantInstructions(['load_skill', 'create_task'])).toContain(
      'Load the task-management skill'
    );
    expect(buildGlobalAssistantInstructions()).toContain('provision_form_target');
  });
});

describe('SHEET bullet vs the agent allowlist', () => {
  it('names read_sheet when the agent holds it', () => {
    const text = buildInlineInstructions(['read_page', 'read_sheet', 'edit_sheet_cells']);
    expect(text).toContain('read_sheet');
  });

  it('names no tool the agent lacks, whichever subset it holds', () => {
    // The bullet can name three tools. Gating only read_sheet left the other
    // two able to do exactly what the gate exists to prevent: an agent holding
    // only read_sheet was still told about edit_sheet_cells.
    const sheetLine = (tools: string[]) =>
      buildInlineInstructions(tools).split('\n').find(l => l.startsWith('• SHEET')) ?? '';

    const readOnly = sheetLine(['read_sheet']);
    expect(readOnly).toContain('read_sheet');
    expect(readOnly).not.toContain('edit_sheet_cells');

    const writeOnly = sheetLine(['edit_sheet_cells']);
    expect(writeOnly).toContain('edit_sheet_cells');
    expect(writeOnly).not.toContain('read_sheet');
    expect(writeOnly).not.toContain('read_page');

    const nothing = sheetLine([]);
    expect(nothing).not.toContain('read_sheet');
    expect(nothing).not.toContain('read_page');
    expect(nothing).not.toContain('edit_sheet_cells');
  });

  it('points at read_page instead when the agent does not', () => {
    // An allowlist saved before read_sheet existed cannot contain it, and
    // naming it produces an unknown-tool call before the model recovers.
    const text = buildInlineInstructions(['read_page', 'edit_sheet_cells']);
    const sheetLine = text.split('\n').find(l => l.startsWith('• SHEET')) ?? '';
    expect(sheetLine).not.toContain('read_sheet');
    expect(sheetLine).toContain('read_page');
    expect(sheetLine).toContain('lineStart');
  });
});

describe('PAGE TYPES bullets — copy_content is only named to agents that hold it', () => {
  // Every agent configured before copy_content existed has a saved
  // enabledTools array without it. Naming a tool the agent does not hold buys
  // an unknown-tool round trip before the model recovers — the same reason the
  // SHEET bullet is composed rather than fixed.
  const withoutCopy = ['read_page', 'replace_lines', 'insert_content'];
  const withCopy = [...withoutCopy, 'copy_content'];

  it('should not mention copy_content when the agent lacks it', () => {
    expect(buildInlineInstructions(withoutCopy)).not.toContain('copy_content');
  });

  it('should mention copy_content when the agent holds it', () => {
    expect(buildInlineInstructions(withCopy)).toContain('copy_content');
  });

  it('should still describe DOCUMENT and CODE pages either way', () => {
    for (const tools of [withoutCopy, withCopy]) {
      const out = buildInlineInstructions(tools);
      expect(out).toContain('• DOCUMENT:');
      expect(out).toContain('• CODE:');
    }
  });

  it('should keep the slim DOCUMENT bullet when the writing-documents skill is reachable', () => {
    // compose() takes precedence over `slim` in buildPageTypes, so the skill
    // branch has to be reproduced inside it — this pins that it still is.
    const out = buildInlineInstructions([...withCopy, 'load_skill']);
    expect(out).toContain('Load the writing-documents skill');
  });

  it('should include copy_content for the undefined sentinel (admin viewer shows everything)', () => {
    expect(buildInlineInstructions(undefined)).toContain('copy_content');
  });
});
