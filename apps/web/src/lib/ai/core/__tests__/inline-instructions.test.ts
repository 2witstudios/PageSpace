/**
 * Tests for apps/web/src/lib/ai/core/inline-instructions.ts
 *
 * Covers:
 * - buildInlineInstructions: always-on sections, tool-gated sections, context interpolation
 * - Tool-gating: TASK_MANAGEMENT, AGENTS, AUTOMATION, SEARCH presence/absence
 * - availableTools=undefined sentinel (include all — backward compat for admin viewer)
 * - availableTools=[] (no tools — only always-on sections)
 */

import { describe, it, expect } from 'vitest';
import { buildInlineInstructions } from '../inline-instructions';

const BASE_CONTEXT = {
  pageTitle: 'My Page',
  pageType: 'DOCUMENT',
  driveName: 'My Drive',
  pagePath: '/my-drive/my-page',
  driveSlug: 'my-drive',
  driveId: 'cuid_drive_123',
};

describe('buildInlineInstructions — always-on sections', () => {
  it('includes WORKSPACE RULES regardless of tool list', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('WORKSPACE RULES');
  });

  it('includes PAGE TYPES regardless of tool list', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('PAGE TYPES');
  });

  it('includes AFTER TOOLS regardless of tool list', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('AFTER TOOLS');
  });

  it('includes MENTIONS regardless of tool list', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('MENTIONS');
  });

  it('includes CONTEXT section regardless of tool list', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('CONTEXT');
  });
});

describe('buildInlineInstructions — context interpolation', () => {
  it('includes pageTitle in CONTEXT', () => {
    const result = buildInlineInstructions({ ...BASE_CONTEXT, pageTitle: 'Sprint Board' }, []);
    expect(result).toContain('Sprint Board');
  });

  it('includes driveName in CONTEXT', () => {
    const result = buildInlineInstructions({ ...BASE_CONTEXT, driveName: 'Engineering Hub' }, []);
    expect(result).toContain('Engineering Hub');
  });

  it('includes driveId in CONTEXT', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('cuid_drive_123');
  });

  it('includes driveSlug in CONTEXT', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result).toContain('my-drive');
  });

  it('appends task-linked annotation when isTaskLinked=true', () => {
    const result = buildInlineInstructions({ ...BASE_CONTEXT, isTaskLinked: true }, []);
    expect(result).toContain('Task-linked page');
  });

  it('does not append task-linked annotation when isTaskLinked=false', () => {
    const result = buildInlineInstructions({ ...BASE_CONTEXT, isTaskLinked: false }, []);
    expect(result).not.toContain('Task-linked page');
  });
});

describe('buildInlineInstructions — TASK_MANAGEMENT gating', () => {
  it('includes TASK MANAGEMENT when create_task is available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['create_task']);
    expect(result).toContain('TASK MANAGEMENT');
  });

  it('includes TASK MANAGEMENT when update_task is available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['update_task']);
    expect(result).toContain('TASK MANAGEMENT');
  });

  it('includes TASK MANAGEMENT when any task tool is available', () => {
    for (const tool of ['delete_task', 'create_task_status', 'reorder_task', 'get_assigned_tasks']) {
      const result = buildInlineInstructions(BASE_CONTEXT, [tool]);
      expect(result).toContain('TASK MANAGEMENT');
    }
  });

  it('excludes TASK MANAGEMENT when no task tools are available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['read_page', 'list_pages']);
    expect(result).not.toContain('TASK MANAGEMENT');
  });
});

describe('buildInlineInstructions — AGENTS gating', () => {
  it('includes AGENTS when ask_agent is available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['ask_agent']);
    expect(result).toContain('AGENTS');
  });

  it('includes AGENTS when list_agents is available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['list_agents']);
    expect(result).toContain('AGENTS');
  });

  it('includes AGENTS when any agent tool is available', () => {
    for (const tool of ['multi_drive_list_agents', 'update_agent_config', 'list_models']) {
      const result = buildInlineInstructions(BASE_CONTEXT, [tool]);
      expect(result).toContain('AGENTS');
    }
  });

  it('excludes AGENTS when no agent tools are available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['read_page', 'create_task']);
    expect(result).not.toContain('AGENTS');
  });
});

describe('buildInlineInstructions — AUTOMATION gating', () => {
  it('includes AUTOMATION when set_task_trigger is available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['set_task_trigger']);
    expect(result).toContain('AUTOMATION');
  });

  it('includes AUTOMATION when any trigger/workflow tool is available', () => {
    for (const tool of ['delete_task_trigger', 'set_calendar_trigger', 'delete_calendar_trigger', 'create_workflow', 'list_workflows']) {
      const result = buildInlineInstructions(BASE_CONTEXT, [tool]);
      expect(result).toContain('AUTOMATION');
    }
  });

  it('excludes AUTOMATION when no trigger or workflow tools are available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['create_task', 'ask_agent']);
    expect(result).not.toContain('AUTOMATION');
  });
});

describe('buildInlineInstructions — SEARCH gating', () => {
  it('includes SEARCH when glob_search is available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['glob_search']);
    expect(result).toContain('SEARCH');
  });

  it('includes SEARCH when any search tool is available', () => {
    for (const tool of ['regex_search', 'multi_drive_search', 'web_search', 'web_fetch']) {
      const result = buildInlineInstructions(BASE_CONTEXT, [tool]);
      expect(result).toContain('SEARCH');
    }
  });

  it('excludes SEARCH when no search tools are available', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, ['read_page', 'create_task']);
    expect(result).not.toContain('SEARCH');
  });
});

describe('buildInlineInstructions — availableTools=undefined sentinel', () => {
  it('includes all sections when availableTools is omitted', () => {
    const result = buildInlineInstructions(BASE_CONTEXT);
    expect(result).toContain('TASK MANAGEMENT');
    expect(result).toContain('AGENTS');
    expect(result).toContain('AUTOMATION');
    expect(result).toContain('SEARCH');
  });

  it('includes all sections when availableTools is explicitly undefined', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, undefined);
    expect(result).toContain('TASK MANAGEMENT');
    expect(result).toContain('AGENTS');
    expect(result).toContain('AUTOMATION');
    expect(result).toContain('SEARCH');
  });
});

describe('buildInlineInstructions — full tool set', () => {
  it('includes all gated sections when all relevant tools are provided', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, [
      'create_task', 'ask_agent', 'set_task_trigger', 'glob_search',
    ]);
    expect(result).toContain('TASK MANAGEMENT');
    expect(result).toContain('AGENTS');
    expect(result).toContain('AUTOMATION');
    expect(result).toContain('SEARCH');
  });

  it('returns a non-empty string', () => {
    const result = buildInlineInstructions(BASE_CONTEXT, []);
    expect(result.length).toBeGreaterThan(0);
  });
});
