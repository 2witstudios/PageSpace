import { describe, it, expect } from 'vitest';
import {
  buildPageAITools,
  filterToolsForReadOnly,
  filterToolsForWebSearch,
  filterToolsForMcpScope,
  filterToolsForMachineBinding,
  isWebSearchTool,
  isImageGenTool,
  filterToolsForImageGen,
  isWriteTool,
  isAccountLevelOnlyTool,
  hasSandboxGitTools,
  suppressGithubIntegrationTools,
  withSessionFamilyTools,
  SESSION_FAMILY_TOOL_NAMES,
} from '../tool-filtering';

const baseline = {
  // read tools
  list_pages: 'list_pages',
  read_page: 'read_page',
  // write tools
  create_page: 'create_page',
  trash_page: 'trash_page',
  // web search
  web_search: 'web_search',
} as const;

describe('buildPageAITools', () => {
  it('returns the full baseline when web search is on and read-only is off', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: false,
      webSearchEnabled: true,
    });

    expect(Object.keys(result).sort()).toEqual(
      ['create_page', 'list_pages', 'read_page', 'trash_page', 'web_search']
    );
  });

  it('strips web_search when webSearchEnabled is false', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: false,
      webSearchEnabled: false,
    });

    expect(result.web_search).toBeUndefined();
    expect(result.read_page).toBe('read_page');
    expect(result.create_page).toBe('create_page');
  });

  it('strips write tools when isReadOnly is true', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: true,
      webSearchEnabled: true,
    });

    expect(result.create_page).toBeUndefined();
    expect(result.trash_page).toBeUndefined();
    expect(result.read_page).toBe('read_page');
    expect(result.web_search).toBe('web_search');
  });

  it('strips both write tools and web_search when both flags are off', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: true,
      webSearchEnabled: false,
    });

    expect(Object.keys(result).sort()).toEqual(['list_pages', 'read_page']);
  });

  it('returns the baseline regardless of any prior agent enabledTools state', () => {
    // The baseline IS the source of truth. The route used to filter against
    // page.enabledTools before this helper ran; this test pins the new
    // contract that no such gate exists here.
    const result = buildPageAITools(baseline, {
      isReadOnly: false,
      webSearchEnabled: true,
    });

    expect(result.web_search).toBe('web_search');
  });
});

describe('filterToolsForReadOnly', () => {
  it('returns input unchanged when isReadOnly is false', () => {
    const result = filterToolsForReadOnly(baseline, false);
    expect(result).toEqual(baseline);
  });

  it('removes write tools when isReadOnly is true', () => {
    const result = filterToolsForReadOnly(baseline, true);
    expect(result.create_page).toBeUndefined();
    expect(result.trash_page).toBeUndefined();
    expect(result.read_page).toBe('read_page');
  });
});

describe('filterToolsForWebSearch', () => {
  it('returns input unchanged when webSearchEnabled is true', () => {
    const result = filterToolsForWebSearch(baseline, true);
    expect(result).toEqual(baseline);
  });

  it('removes web_search when webSearchEnabled is false', () => {
    const result = filterToolsForWebSearch(baseline, false);
    expect(result.web_search).toBeUndefined();
    expect(result.read_page).toBe('read_page');
  });
});

describe('filterToolsForMcpScope', () => {
  const withDrive = {
    create_drive: 'create_drive',
    list_pages: 'list_pages',
    read_page: 'read_page',
  };

  it('returns input unchanged when isScoped is false (unscoped/session callers see create_drive)', () => {
    const result = filterToolsForMcpScope(withDrive, false);
    expect(result).toEqual(withDrive);
    expect(result.create_drive).toBe('create_drive');
  });

  it('removes create_drive when isScoped is true (drive-scoped MCP token)', () => {
    const result = filterToolsForMcpScope(withDrive, true);
    expect(result.create_drive).toBeUndefined();
    expect(result.list_pages).toBe('list_pages');
    expect(result.read_page).toBe('read_page');
  });
});

describe('filterToolsForMachineBinding', () => {
  const withMachineTools = {
    switch_machine: 'switch_machine',
    list_machines: 'list_machines',
    read_page: 'read_page',
  };

  it('returns input unchanged when not bound', () => {
    const result = filterToolsForMachineBinding(withMachineTools, false);
    expect(result).toEqual(withMachineTools);
    expect(result.switch_machine).toBe('switch_machine');
    expect(result.list_machines).toBe('list_machines');
  });

  it('removes switch_machine and list_machines when bound to a machine pane', () => {
    const result = filterToolsForMachineBinding(withMachineTools, true);
    expect(result.switch_machine).toBeUndefined();
    expect(result.list_machines).toBeUndefined();
    expect(result.read_page).toBe('read_page');
  });
});

describe('isAccountLevelOnlyTool', () => {
  it('classifies create_drive as account-level-only', () => {
    expect(isAccountLevelOnlyTool('create_drive')).toBe(true);
  });

  it('does not classify ordinary tools as account-level-only', () => {
    expect(isAccountLevelOnlyTool('list_pages')).toBe(false);
    expect(isAccountLevelOnlyTool('rename_drive')).toBe(false);
  });
});

describe('filterToolsForImageGen', () => {
  const tools = { read_page: 'r', generate_image: 'g', web_search: 'w' };

  it('keeps generate_image when enabled', () => {
    expect(Object.keys(filterToolsForImageGen(tools, true)).sort()).toEqual(
      ['generate_image', 'read_page', 'web_search']
    );
  });

  it('drops only generate_image when disabled', () => {
    expect(Object.keys(filterToolsForImageGen(tools, false)).sort()).toEqual(['read_page', 'web_search']);
  });
});

describe('isWriteTool / isWebSearchTool predicates', () => {
  it('classifies write tools correctly', () => {
    expect(isWriteTool('create_page')).toBe(true);
    expect(isWriteTool('send_channel_message')).toBe(true);
    expect(isWriteTool('delete_channel_message')).toBe(true);
    expect(isWriteTool('read_page')).toBe(false);
    expect(isWriteTool('web_search')).toBe(false);
  });

  it('classifies explicit per-entity trash/restore tools as writes', () => {
    expect(isWriteTool('trash_page')).toBe(true);
    expect(isWriteTool('trash_drive')).toBe(true);
    expect(isWriteTool('restore_page')).toBe(true);
    expect(isWriteTool('restore_drive')).toBe(true);
  });

  it('classifies web search tools correctly', () => {
    expect(isWebSearchTool('web_search')).toBe(true);
    expect(isWebSearchTool('read_page')).toBe(false);
    expect(isWebSearchTool('create_page')).toBe(false);
    expect(isImageGenTool('generate_image')).toBe(true);
    expect(isImageGenTool('web_search')).toBe(false);
  });

  it('classifies insert_content as a write tool', () => {
    expect(isWriteTool('insert_content')).toBe(true);
  });

  it('excludes insert_content in read-only mode', () => {
    const tools = {
      insert_content: 'w',
      read_page: 'r',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('insert_content');
    expect(filtered).toHaveProperty('read_page');
  });

  it('classifies set_home_page as a write tool and excludes it in read-only mode', () => {
    expect(isWriteTool('set_home_page')).toBe(true);
    const tools = { set_home_page: 'w', list_pages: 'r' };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('set_home_page');
    expect(filtered).toHaveProperty('list_pages');
  });

  it('classifies workflow tools: writes are write tools, list is read', () => {
    expect(isWriteTool('create_workflow')).toBe(true);
    expect(isWriteTool('update_workflow')).toBe(true);
    expect(isWriteTool('delete_workflow')).toBe(true);
    expect(isWriteTool('list_workflows')).toBe(false);
    expect(isWriteTool('set_calendar_trigger')).toBe(true);
    expect(isWriteTool('delete_calendar_trigger')).toBe(true);
    expect(isWriteTool('set_task_trigger')).toBe(true);
    expect(isWriteTool('delete_task_trigger')).toBe(true);
  });

  it('excludes workflow write tools in read-only mode but keeps list_workflows', () => {
    const tools = {
      list_workflows: 'r',
      create_workflow: 'w',
      update_workflow: 'w',
      delete_workflow: 'w',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).toHaveProperty('list_workflows');
    expect(filtered).not.toHaveProperty('create_workflow');
    expect(filtered).not.toHaveProperty('update_workflow');
    expect(filtered).not.toHaveProperty('delete_workflow');
  });

  it('excludes trigger write tools in read-only mode', () => {
    const tools = {
      set_calendar_trigger: 'w',
      delete_calendar_trigger: 'w',
      set_task_trigger: 'w',
      delete_task_trigger: 'w',
      list_calendar_events: 'r',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('set_calendar_trigger');
    expect(filtered).not.toHaveProperty('delete_calendar_trigger');
    expect(filtered).not.toHaveProperty('set_task_trigger');
    expect(filtered).not.toHaveProperty('delete_task_trigger');
    expect(filtered).toHaveProperty('list_calendar_events');
  });

  it('classifies sandbox mutators (bash/writeFile/editFile + writing git/gh) as write tools', () => {
    for (const name of [
      'bash',
      'writeFile',
      'editFile',
      'git_clone',
      'git_add',
      'git_commit',
      'git_push',
      'git_checkout',
      'git_revert',
      'gh_pr_create',
      'gh_pr_merge',
      'gh_pr_comment',
      'gh_pr_edit',
      'gh_pr_update_branch',
      'gh_pr_thread_resolve',
      'gh_run_rerun',
      'gh_workflow_run',
      'gh_issue_create',
      'gh_issue_comment',
      'gh_issue_edit',
      'gh_issue_close',
      'gh_issue_reopen',
      'gh_repo_fork',
      'gh_repo_create',
    ]) {
      expect(isWriteTool(name)).toBe(true);
    }
  });

  it('keeps read-only sandbox tools available (readFile, git_status/diff/log, gh_pr_view/list)', () => {
    for (const name of [
      'readFile',
      'git_status',
      'git_diff',
      'git_log',
      'git_show',
      'git_blame',
      'gh_pr_list',
      'gh_pr_view',
      'gh_pr_thread_list',
      'gh_workflow_list',
      'gh_issue_list',
      'gh_issue_view',
      'gh_repo_view',
      'gh_repo_list',
      'gh_search',
      'gh_label_list',
    ]) {
      expect(isWriteTool(name)).toBe(false);
    }
  });

  it('excludes sandbox mutators in read-only mode but keeps readFile and git_status', () => {
    const tools = {
      bash: 'w',
      writeFile: 'w',
      editFile: 'w',
      git_push: 'w',
      gh_pr_create: 'w',
      readFile: 'r',
      git_status: 'r',
      gh_pr_view: 'r',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('bash');
    expect(filtered).not.toHaveProperty('writeFile');
    expect(filtered).not.toHaveProperty('editFile');
    expect(filtered).not.toHaveProperty('git_push');
    expect(filtered).not.toHaveProperty('gh_pr_create');
    expect(filtered).toHaveProperty('readFile');
    expect(filtered).toHaveProperty('git_status');
    expect(filtered).toHaveProperty('gh_pr_view');
  });
});

describe('hasSandboxGitTools', () => {
  it('returns true when a sandbox git tool is present', () => {
    expect(hasSandboxGitTools({ git_status: 'x', read_page: 'x' })).toBe(true);
  });

  it('returns true when only a gh_ tool is present', () => {
    expect(hasSandboxGitTools({ gh_pr_create: 'x' })).toBe(true);
  });

  it('returns false when no sandbox git tool is present', () => {
    expect(hasSandboxGitTools({ read_page: 'x', bash: 'x' })).toBe(false);
  });

  it('returns false for an empty tool set', () => {
    expect(hasSandboxGitTools({})).toBe(false);
  });
});

describe('suppressGithubIntegrationTools', () => {
  const integrationTools = {
    int__github__list_repos: 'x',
    int__github__create_pr_review_comment: 'x',
    int__slack__send_message: 'x',
  };

  it('strips int__github__* tools when sandbox git tools are registered', () => {
    const result = suppressGithubIntegrationTools(integrationTools, { git_clone: 'x' });
    expect(result).not.toHaveProperty('int__github__list_repos');
    expect(result).not.toHaveProperty('int__github__create_pr_review_comment');
    expect(result).toHaveProperty('int__slack__send_message');
  });

  it('leaves integration tools untouched when no sandbox git tools are registered', () => {
    const result = suppressGithubIntegrationTools(integrationTools, { read_page: 'x' });
    expect(result).toEqual(integrationTools);
  });

  it('leaves integration tools untouched against an empty current tool set', () => {
    const result = suppressGithubIntegrationTools(integrationTools, {});
    expect(result).toEqual(integrationTools);
  });
});

describe('withSessionFamilyTools', () => {
  const driveAgentTools = {
    read_page: 'read_page',
    ask_agent: 'ask_agent',
    bash: 'bash',
  };
  const sessionFamily = {
    list_sessions: 'list_sessions',
    add_session: 'add_session',
    move_session: 'move_session',
    kill_session: 'kill_session',
    read_session: 'read_session',
    send_session: 'send_session',
  };

  it('leaves the drive-agent tool set byte-unchanged when the conversation is not machine-bound', () => {
    const result = withSessionFamilyTools(driveAgentTools, sessionFamily, false);
    expect(result).toEqual(driveAgentTools);
    expect(Object.keys(result)).toEqual(Object.keys(driveAgentTools));
  });

  it('registers the whole session family for a machine-bound conversation', () => {
    const result = withSessionFamilyTools(driveAgentTools, sessionFamily, true);
    expect(Object.keys(result).sort()).toEqual(
      [...Object.keys(driveAgentTools), ...Object.keys(sessionFamily)].sort()
    );
  });

  it('names every session-family tool it registers', () => {
    expect([...SESSION_FAMILY_TOOL_NAMES].sort()).toEqual(Object.keys(sessionFamily).sort());
  });
});
