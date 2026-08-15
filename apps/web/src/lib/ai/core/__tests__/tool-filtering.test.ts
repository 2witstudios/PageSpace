import { describe, it, expect } from 'vitest';
import {
  buildPageAITools,
  filterToolsForReadOnly,
  filterToolsForWebSearch,
  filterToolsForMcpScope,
  isWebSearchTool,
  isImageGenTool,
  filterToolsForImageGen,
  isWriteTool,
  isAccountLevelOnlyTool,
  hasSandboxGitTools,
  suppressGithubIntegrationTools,
  filterToolsForAgentAllowlist,
  filterToolsForSandboxEnablement,
  filterToolsForSandboxTier,
  filterToolsForEphemeralWorkspace,
  WORKER_DISPATCH_TOOL_NAMES,
  SANDBOX_COMPUTE_TOOL_NAMES,
  SANDBOX_TOOL_NAMES,
  SESSION_FAMILY_TOOL_NAMES,
} from '../tool-filtering';
import { SANDBOX_CORE_TOOL_NAMES, createSandboxTools } from '../../tools/sandbox-tools';
import { SANDBOX_GIT_TOOL_NAMES } from '../../tools/sandbox-git-tools';

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

  it('keeps load_skill in read-only mode (skills inform planning, not writing)', () => {
    const tools = { ...baseline, load_skill: 'load_skill' };
    const result = filterToolsForReadOnly(tools, true);
    expect(result.load_skill).toBe('load_skill');
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

describe('SESSION_FAMILY_TOOL_NAMES', () => {
  const MUTATIONS = ['spawn_session', 'send_session', 'kill_session', 'spawn_shell', 'send_shell', 'kill_shell'];
  const READS = ['list_sessions', 'read_session', 'read_shell'];

  it('names the nine session/shell orchestration tools', () => {
    expect([...SESSION_FAMILY_TOOL_NAMES].sort()).toEqual([...MUTATIONS, ...READS].sort());
  });

  // The security property, not a restatement of the list: a read-only agent must
  // not be able to spawn a shell (and write through it), but must still be able
  // to observe its own sessions.
  it('given read-only mode, should strip every session/shell MUTATION', () => {
    const tools = Object.fromEntries(SESSION_FAMILY_TOOL_NAMES.map((name) => [name, {}]));
    const filtered = filterToolsForReadOnly(tools, true);

    for (const name of MUTATIONS) {
      expect(filtered, `${name} must be write-gated`).not.toHaveProperty(name);
    }
  });

  it('given read-only mode, should KEEP the session/shell read verbs', () => {
    const tools = Object.fromEntries(SESSION_FAMILY_TOOL_NAMES.map((name) => [name, {}]));
    const filtered = filterToolsForReadOnly(tools, true);

    for (const name of READS) {
      expect(filtered, `${name} is a read and must survive read-only`).toHaveProperty(name);
    }
  });
});

describe('filterToolsForAgentAllowlist', () => {
  const allTools = {
    read_page: 'read_page',
    create_page: 'create_page',
    bash: 'bash',
    list_sessions: 'list_sessions',
    spawn_session: 'spawn_session',
    send_session: 'send_session',
    read_session: 'read_session',
    kill_session: 'kill_session',
    spawn_shell: 'spawn_shell',
    send_shell: 'send_shell',
    read_shell: 'read_shell',
    kill_shell: 'kill_shell',
  };

  it('leaves an unconfigured page unrestricted (null allowlist)', () => {
    expect(filterToolsForAgentAllowlist(allTools, null)).toEqual(allTools);
  });

  it('filters the session/shell family like any other tool — no exemption', () => {
    // The old machine-binding exemption is gone: an operator who restricted an
    // agent's tools restricted the session family too.
    const result = filterToolsForAgentAllowlist(allTools, ['read_page']);
    expect(Object.keys(result)).toEqual(['read_page']);
  });

  it('blocks every listed tool under an empty allowlist, session family included', () => {
    expect(filterToolsForAgentAllowlist(allTools, [])).toEqual({});
  });

  it('keeps allowlisted session-family tools when they are named explicitly', () => {
    const result = filterToolsForAgentAllowlist(allTools, ['spawn_session', 'read_session']);
    expect(Object.keys(result).sort()).toEqual(['read_session', 'spawn_session']);
  });

  it('keeps only names present in both the tool set and the allowlist', () => {
    const driveTools = { read_page: 'read_page', ask_agent: 'ask_agent' };
    expect(filterToolsForAgentAllowlist(driveTools, ['ask_agent', 'spawn_session'])).toEqual({
      ask_agent: 'ask_agent',
    });
  });
});

/**
 * Issue #2204 follow-up, F3 (rebuilt for the session/shell family). The
 * mutating members must live in WRITE_TOOLS: spawn_session/send_session run a
 * full agent loop in the target that can execute arbitrary shell commands, so
 * a read-only conversation that kept them would be read-only in name only.
 */
describe('read-only mode vs the session/shell family', () => {
  const sessionFamily = {
    list_sessions: 'list_sessions',
    spawn_session: 'spawn_session',
    send_session: 'send_session',
    read_session: 'read_session',
    kill_session: 'kill_session',
    spawn_shell: 'spawn_shell',
    send_shell: 'send_shell',
    read_shell: 'read_shell',
    kill_shell: 'kill_shell',
  };

  it('classifies the mutating session/shell tools as write tools', () => {
    for (const name of [
      'spawn_session',
      'send_session',
      'kill_session',
      'spawn_shell',
      'send_shell',
      'kill_shell',
    ]) {
      expect(isWriteTool(name)).toBe(true);
    }
  });

  it('keeps the read members out of WRITE_TOOLS', () => {
    for (const name of ['list_sessions', 'read_session', 'read_shell']) {
      expect(isWriteTool(name)).toBe(false);
    }
  });

  it('no longer classifies the retired add_session/move_session names', () => {
    expect(isWriteTool('add_session')).toBe(false);
    expect(isWriteTool('move_session')).toBe(false);
  });

  it('given the full family, read-only should drop every mutating tool and keep the reads', () => {
    expect(Object.keys(filterToolsForReadOnly(sessionFamily, true)).sort()).toEqual([
      'list_sessions',
      'read_session',
      'read_shell',
    ]);
  });

  it('given read-only OFF, should keep the whole family', () => {
    expect(Object.keys(filterToolsForReadOnly(sessionFamily, false)).sort()).toEqual(
      Object.keys(sessionFamily).sort(),
    );
  });
});

describe('filterToolsForSandboxEnablement', () => {
  const sandboxishSample = {
    bash: {},
    editFile: {},
    git_status: {},
    spawn_session: {},
    read_shell: {},
    // non-sandbox neighbours that must survive either way
    read_page: {},
    create_page: {},
  };

  it('given sandboxEnabled: false (the default), strips EVERY sandbox-family tool', () => {
    const filtered = filterToolsForSandboxEnablement(sandboxishSample, false);
    expect(Object.keys(filtered).sort()).toEqual(['create_page', 'read_page']);
  });

  it('given sandboxEnabled: true, returns the set untouched', () => {
    expect(filterToolsForSandboxEnablement(sandboxishSample, true)).toEqual(sandboxishSample);
  });

  it('the OFF state strips reads too — the switch is agent configuration, not the read-only gate', () => {
    // read_shell/list_sessions survive READ-ONLY mode; they must NOT survive a
    // disabled sandbox, whose whole tool surface is off.
    const filtered = filterToolsForSandboxEnablement({ read_shell: {}, list_sessions: {} }, false);
    expect(Object.keys(filtered)).toEqual([]);
  });
});

describe('filterToolsForEphemeralWorkspace', () => {
  const sample = {
    list_sessions: {},
    spawn_session: {},
    send_session: {},
    read_session: {},
    kill_session: {},
    bash: {},
    read_page: {},
  };

  it('the set holds exactly the pair that leaves a worker running after it returns', () => {
    expect([...WORKER_DISPATCH_TOOL_NAMES].sort()).toEqual(['send_session', 'spawn_session']);
    // Drift guard: every member must be part of the session family — a
    // rename there must be mirrored here or the strip silently misses it.
    for (const name of WORKER_DISPATCH_TOOL_NAMES) {
      expect(SESSION_FAMILY_TOOL_NAMES).toContain(name);
    }
  });

  it('when the workspace does not outlive the run, strips exactly the worker-dispatch pair — reads/kill and everything else stay', () => {
    const filtered = filterToolsForEphemeralWorkspace(sample, false);
    expect(Object.keys(filtered).sort()).toEqual([
      'bash',
      'kill_session',
      'list_sessions',
      'read_page',
      'read_session',
    ]);
  });

  it('when the workspace outlives the run, passes everything through untouched', () => {
    expect(filterToolsForEphemeralWorkspace(sample, true)).toBe(sample);
  });
});

describe('filterToolsForSandboxTier', () => {
  const sample = {
    bash: {},
    editFile: {},
    git_status: {},
    spawn_shell: {},
    read_shell: {},
    // The chat-only session family — free on every plan (review #2326).
    list_sessions: {},
    spawn_session: {},
    send_session: {},
    read_session: {},
    kill_session: {},
    // non-sandbox neighbours
    read_page: {},
  };

  it('given an INELIGIBLE payer, strips compute (bash/files, git, PTY shells) but KEEPS the chat-only session family', () => {
    const filtered = filterToolsForSandboxTier(sample, false);
    expect(Object.keys(filtered).sort()).toEqual([
      'kill_session',
      'list_sessions',
      'read_page',
      'read_session',
      'send_session',
      'spawn_session',
    ]);
  });

  it('given an eligible payer, returns the set untouched', () => {
    expect(filterToolsForSandboxTier(sample, true)).toEqual(sample);
  });
});

describe('SANDBOX_COMPUTE_TOOL_NAMES', () => {
  it('is exactly SANDBOX_TOOL_NAMES minus the chat-only session tools', () => {
    const chatOnly = ['list_sessions', 'spawn_session', 'send_session', 'read_session', 'kill_session'];
    const expected = [...SANDBOX_TOOL_NAMES].filter((name) => !chatOnly.includes(name)).sort();
    expect([...SANDBOX_COMPUTE_TOOL_NAMES].sort()).toEqual(expected);
  });
});

describe('SANDBOX_TOOL_NAMES', () => {
  it('is exactly core ∪ git ∪ session families', () => {
    expect([...SANDBOX_TOOL_NAMES].sort()).toEqual(
      [...new Set([...SANDBOX_CORE_TOOL_NAMES, ...SANDBOX_GIT_TOOL_NAMES, ...SESSION_FAMILY_TOOL_NAMES])].sort(),
    );
  });

  it('SANDBOX_CORE_TOOL_NAMES never drifts from what createSandboxTools actually builds', () => {
    const built = createSandboxTools({
      runDeps: {} as never,
      resolveContext: (() => {}) as never,
      gate: (() => {}) as never,
    });
    expect(Object.keys(built).sort()).toEqual([...SANDBOX_CORE_TOOL_NAMES].sort());
  });
});
