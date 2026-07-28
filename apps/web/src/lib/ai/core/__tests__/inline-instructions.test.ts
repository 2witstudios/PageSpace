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
  it('includes AGENTS when ask_agent is available', () => {
    const result = buildInlineInstructions(['ask_agent']);
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
      'create_task', 'ask_agent', 'set_task_trigger', 'glob_search',
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
