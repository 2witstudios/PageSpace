/**
 * Tests for apps/web/src/lib/ai/core/system-prompt.ts
 *
 * Covers:
 * - buildSystemPrompt: read-only mode, sandbox guidance
 *   (location/drive/page context lives in location-prompt.ts now — see
 *   location-prompt.test.ts — buildSystemPrompt takes no location args so
 *   the stable system prefix stays byte-identical across turns)
 * - buildPersonalizationPrompt: enabled/disabled, section presence
 * - getWelcomeMessage / getErrorMessage
 * - estimateSystemPromptTokens
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildPersonalizationPrompt,
  buildNonCoreToolNamesPrompt,
  getWelcomeMessage,
  getErrorMessage,
  estimateSystemPromptTokens,
} from '../system-prompt';

describe('buildSystemPrompt — general', () => {
  it('given no args, returns string containing core prompt text', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('PageSpace AI');
  });

  it('given read-only mode, includes READ-ONLY constraint', () => {
    const result = buildSystemPrompt(true);
    expect(result).toContain('READ-ONLY');
  });

  it('given non-read-only mode, does not include READ-ONLY constraint', () => {
    const result = buildSystemPrompt(false);
    expect(result).not.toContain('READ-ONLY');
  });

  it('never contains location/drive/page-specific text — that lives in the volatile block', () => {
    const result = buildSystemPrompt(false);
    expect(result).not.toContain('DASHBOARD CONTEXT');
    expect(result).not.toContain('DRIVE CONTEXT');
    expect(result).not.toContain('PAGE CONTEXT');
  });

  it('the EXECUTION BIAS examples are hedged, not declared unconditionally available', () => {
    // BEHAVIOR_PROMPT (which holds EXECUTION BIAS) is always-on and unconditional —
    // it can't be gated per-tool the way SANDBOX_INSTRUCTIONS/AGENTS/AUTOMATION are.
    // A read-only turn or a restricted allowlist can strip bash, worker dispatch,
    // trigger setters, and content-writing tools entirely, so the examples here must
    // read as "check whether you can," never as "you can" — for every mode, since
    // this block doesn't vary by isReadOnly or allowedToolNames.
    for (const result of [
      buildSystemPrompt(false),
      buildSystemPrompt(true),
      buildSystemPrompt(false, undefined, true, ['read_page']),
    ]) {
      expect(result).toContain('EXECUTION BIAS');
      expect(result).not.toContain('is well within reach');
    }
  });
});

describe('buildSystemPrompt — sandbox guidance', () => {
  it('given codeExecutionEnabled true, should include the sandbox guidance section', () => {
    const result = buildSystemPrompt(false, undefined, true);
    expect(result).toContain('/workspace');
    expect(result).toContain('persists');
  });

  it('given the default call (no flag), should NOT include sandbox guidance', () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain('/workspace');
  });

  it('given codeExecutionEnabled false explicitly, should NOT include sandbox guidance', () => {
    const result = buildSystemPrompt(false, undefined, false);
    expect(result).not.toContain('/workspace');
  });

  it('given codeExecutionEnabled true but allowedToolNames has no sandbox tool, should NOT include sandbox guidance', () => {
    // The per-agent sandboxEnabled switch (filterToolsForSandboxEnablement) strips
    // every sandbox tool including bash from allowedToolNames without touching the
    // deployment-wide codeExecutionEnabled flag — the section must follow the tools
    // the agent actually has, not the global kill switch alone.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'create_task']);
    expect(result).not.toContain('/workspace');
  });

  it('given codeExecutionEnabled true and allowedToolNames includes bash, should include sandbox guidance', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash']);
    expect(result).toContain('/workspace');
  });

  it('given codeExecutionEnabled true and allowedToolNames includes a non-bash sandbox tool (bash unchecked in the per-agent allowlist), should still include sandbox guidance', () => {
    // The Default Tools settings UI (PageAgentSettingsTab) is a per-tool checkbox
    // list — an admin can enable writeFile/editFile/git_clone/spawn_session while
    // leaving bash specifically unchecked. That agent can still call those sandbox
    // tools via execute_tool and needs the /workspace path-resolution and
    // persistence guidance just as much as a bash-enabled agent does.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'writeFile', 'git_clone']);
    expect(result).toContain('/workspace');
  });

  it('given a non-bash sandbox tool set (no execution tool), does NOT claim it can run scripts/scrapers', () => {
    // codex review: hasSandboxComputeTools gates the WHOLE block correctly (an
    // agent with only readFile/writeFile/git_status still needs path-resolution
    // and editFile/git mechanics), but the opening sentence specifically claimed
    // "use it for scripts, scrapers, data processing, calling external APIs" —
    // an execution claim a file/git-only agent (no bash) cannot back up.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'writeFile', 'git_clone']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('scripts, scrapers');
  });

  it('given bash is present, does claim it can run scripts/scrapers', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash']);
    expect(result).toContain('scripts, scrapers');
  });

  it('given allowedToolNames omitted, does claim it can run scripts/scrapers (undefined = no filtering context)', () => {
    const result = buildSystemPrompt(false, undefined, true);
    expect(result).toContain('scripts, scrapers');
  });

  it('given codeExecutionEnabled true and allowedToolNames omitted, should include sandbox guidance (undefined = no filtering context)', () => {
    // Matches the sentinel semantics used elsewhere in this module (buildInlineInstructions,
    // buildNonCoreToolNamesPrompt): undefined means "no tool list to filter against", not "no tools".
    const result = buildSystemPrompt(false, undefined, true);
    expect(result).toContain('/workspace');
  });

  it('given isReadOnly true with read-only-safe sandbox tools (readFile, git_status), preserves sandbox guidance', () => {
    // codex review: filterToolsForReadOnly only strips WRITE_TOOLS — readFile,
    // git_status, git_diff, and the gh_* inspection tools are deliberately NOT
    // write tools and remain in allowedToolNames during a read-only turn. A
    // blanket isReadOnly suppression of the whole block would take away the
    // /workspace path-resolution and untrusted-output guidance those tools
    // still need. The block must follow tool presence, not the read-only flag.
    const result = buildSystemPrompt(true, undefined, true, ['read_page', 'readFile', 'git_status']);
    expect(result).toContain('/workspace');
  });

  it('given isReadOnly true with only bash-family write tools stripped, does not claim execution or drive write-back', () => {
    // In real read-only turns bash/writeFile/create_page etc. are already gone
    // from allowedToolNames (they're WRITE_TOOLS) by the time this runs — assert
    // that directly rather than depending on isReadOnly as a second gate.
    const result = buildSystemPrompt(true, undefined, true, ['read_page', 'readFile', 'git_status']);
    expect(result).not.toContain('scripts, scrapers');
    expect(result).not.toContain('write meaningful output back into the drive');
  });

  it('given no PageSpace drive-write tools, does NOT claim it can write results into a Sheet or Document', () => {
    // codex review: an allowlist with only writeFile/git_clone (no create_page,
    // replace_lines, insert_content, edit_sheet_cells) can edit sandbox files but
    // cannot write into the drive — the earlier non-bash fallback still made that
    // claim unconditionally in both branches.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'writeFile', 'git_clone']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('write meaningful output back into the drive');
  });

  it('given a PageSpace content-writing tool is present, does claim it can write results into a Sheet or Document', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'replace_lines']);
    expect(result).toContain('write meaningful output back into the drive');
  });

  it('given only create_page (no content-writing tool), does NOT claim it can write results into a Sheet or Document', () => {
    // codex review: create_page's inputSchema has no content field — it creates
    // only a blank destination page. Writing content in needs replace_lines,
    // insert_content, edit_sheet_cells, or copy_content afterwards.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'create_page']);
    expect(result).not.toContain('write meaningful output back into the drive');
  });

  it('given copy_content is present, does claim it can write results into a Sheet or Document', () => {
    // copy_content can write into a page (including one just created via create_page).
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'copy_content']);
    expect(result).toContain('write meaningful output back into the drive');
  });

  it('given only a Document-writer tool (replace_lines), claims a Document but not a Sheet', () => {
    // codex review: replace_lines/insert_content/copy_content explicitly reject
    // Sheet pages, so a bullet that lists both destinations for a Document-only
    // agent claims a capability (writing a Sheet) it doesn't have.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'replace_lines']);
    expect(result).toContain('write meaningful output back into the drive (a Document)');
  });

  it('given only the Sheet-writer tool (edit_sheet_cells), claims a Sheet but not a Document', () => {
    // edit_sheet_cells explicitly rejects non-Sheet pages.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'edit_sheet_cells']);
    expect(result).toContain('write meaningful output back into the drive (a Sheet)');
  });

  it('given both a Document-writer and the Sheet-writer, claims a Sheet or Document', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'replace_lines', 'edit_sheet_cells']);
    expect(result).toContain('write meaningful output back into the drive (a Sheet or a Document)');
  });

  it('given a git-only allowlist (git_clone), does not mention bash, file tools, or gh_* tools', () => {
    // CodeRabbit review: hasSandboxComputeTools correctly renders the block for
    // a git-only agent (it still needs path/persistence guidance), but the
    // "Key tools" list and several bullets unconditionally named bash/readFile/
    // writeFile/editFile/gh_* — tools this allowlist doesn't grant.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'git_clone']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('bash');
    expect(result).not.toContain('readFile');
    expect(result).not.toContain('writeFile');
    expect(result).not.toContain('editFile');
    expect(result).not.toContain('gh_pr');
  });

  it('given a file-only allowlist (writeFile), does not mention bash or git/gh tools', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'writeFile']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('bash');
    expect(result).not.toContain('git_clone');
    expect(result).not.toContain('gh_pr');
  });

  it('given the full sandbox toolkit, still mentions bash, file tools, and git/gh tools', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'writeFile', 'editFile', 'git_clone']);
    expect(result).toContain('bash');
    expect(result).toContain('editFile');
    expect(result).toContain('git_clone');
  });

  it('given spawn_shell+send_shell but no bash, does NOT claim bash-specific fresh-process/GitHub-credential mechanics', () => {
    // codex review: a persistent PTY (send_shell) does not share bash's
    // "fresh process every call, cd doesn't persist" behavior — hasBash must
    // be tracked separately from the broader canExecute predicate.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell', 'send_shell', 'git_clone']);
    expect(result).toContain('scripts, scrapers'); // canExecute claim still holds
    expect(result).not.toContain('fresh process');
    expect(result).not.toContain('NO GitHub credentials');
    expect(result).not.toContain('bash stdout/stderr');
  });

  it('given only git_status (not git_branch), mentions git_status but not git_branch', () => {
    // codex review: a read-only surface retaining only git_status must not be
    // told to also call the stripped git_branch.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'git_status']);
    expect(result).toContain('git_status');
    expect(result).not.toContain('git_branch');
  });

  it('given only gh_pr_list (not gh_pr_view), mentions gh_pr_list but not gh_pr_view', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'gh_pr_list']);
    expect(result).toContain('gh_pr_list');
    expect(result).not.toContain('gh_pr_view');
  });

  it('given only gh_pr_edit (not gh_pr_thread_list/resolve or gh_repo_view), only the gh_pr_edit clause appears', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'gh_pr_edit']);
    expect(result).toContain('gh_pr_edit');
    expect(result).not.toContain('gh_pr_thread_list');
    expect(result).not.toContain('gh_repo_view');
  });

  it('given read_shell with list_sessions (discoverable, no spawn_shell), does not claim spawn_session/spawn_shell', () => {
    // codex review: read_shell can survive read-only filtering alongside
    // list_sessions — it must not pull in spawn_session/send_session/
    // kill_session/spawn_shell/send_shell as though all were callable.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'read_shell', 'list_sessions']);
    expect(result).toContain('read_shell');
    expect(result).not.toContain('spawn_session');
    expect(result).not.toContain('spawn_shell');
  });

  it('given only spawn_session (no send/read/kill_session), the session bullet omits the absent follow-up verbs', () => {
    // spawn_session alone isn't a compute tool (it's the free chat-only
    // session family), so pair it with bash to trigger the block.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'spawn_session']);
    expect(result).toContain('spawn_session');
    expect(result).not.toContain('send_session');
    expect(result).not.toContain('kill_session');
  });

  it('given only git_clone (a PATH-family tool, no cwd-family git tool), does not claim "the rest of the git_* tools take cwd"', () => {
    // codex review: git_clone/git_init take `path` (sandbox-git/tools/repo.ts
    // schema), not `cwd` — an agent holding only git_clone has no "rest" of
    // cwd-family git tools, so that clause must not render.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'git_clone']);
    expect(result).toContain('git_clone takes path');
    expect(result).not.toContain('git_init');
    expect(result).not.toContain('the rest of the git_* tools take cwd');
  });

  it('given both git_clone and git_init, names both path-family tools', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'git_clone', 'git_init']);
    expect(result).toContain('git_clone/git_init take path');
  });

  it('given only git_init (not git_clone), names only git_init', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'git_init']);
    expect(result).toContain('git_init takes path');
    expect(result).not.toContain('git_clone');
  });

  it('given a cwd-family git tool (git_checkout), does claim the git_* cwd clause', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'git_checkout']);
    expect(result).toContain('the rest of the git_* tools take cwd');
  });

  it('given spawn_shell with only send_shell (no read_shell), describes send_shell but not a scrollback-read role', () => {
    // codex review: a fixed "type keystrokes / read scrollback respectively"
    // suffix wrongly described read_shell's role even when only send_shell
    // was present.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell', 'send_shell']);
    expect(result).toContain('send_shell types keystrokes');
    expect(result).not.toContain('reads scrollback');
  });

  it('given spawn_shell with only read_shell (no send_shell), describes read_shell but not a keystroke-typing role', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell', 'read_shell']);
    expect(result).toContain('read_shell reads scrollback');
    expect(result).not.toContain('types keystrokes');
  });

  it('given spawn_shell and send_shell but no bash, still claims it can run scripts/scrapers', () => {
    // codex review: send_shell submits commands to a PTY and can run scripts or
    // data-processing jobs just like bash — checking only for the literal 'bash'
    // name missed this valid execution surface.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell', 'send_shell']);
    expect(result).toContain('scripts, scrapers');
  });

  it('given spawn_shell without send_shell, does NOT claim execution (can dispatch but not observe/run interactively)', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell']);
    expect(result).not.toContain('scripts, scrapers');
  });

  it('given send_shell+list_sessions (no spawn_shell), describes it as conditional but does NOT claim unconditional execution', () => {
    // codex review, fresh evidence: list_sessions can legitimately return
    // shells: [] in a fresh conversation (session-tools.ts) — send_shell
    // paired with list_sessions (no spawn_shell to GUARANTEE a shell exists)
    // is only conditionally usable, so it must not drive the confident
    // "use it for scripts, scrapers" claim. The Sessions & shells bullet
    // still describes the conditional capability with hedged wording.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'list_sessions', 'send_shell']);
    expect(result).not.toContain('scripts, scrapers');
    expect(result).toContain('send_shell submits commands to a shell already running');
    expect(result).not.toContain('spawn_shell opens a persistent PTY');
  });

  it('given send_shell with neither spawn_shell nor list_sessions, does NOT claim execution or describe send_shell as usable', () => {
    // codex review, fresh evidence: send_shell's inputSchema requires a
    // caller-supplied shellId (session-tools.ts) and cannot create or
    // discover one itself. Without spawn_shell (to create a shell) or
    // list_sessions (to find an existing one), send_shell has no usable
    // shellId — the regression test for the "standalone send_shell" case
    // had silently supplied list_sessions, masking this.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'send_shell']);
    expect(result).not.toContain('scripts, scrapers');
    expect(result).not.toContain('send_shell submits commands');
  });

  it('given spawn_shell without send_shell (no execute, no write, no file/git tools), does NOT claim file/git tools', () => {
    // codex review, fresh evidence: the non-executing fallback wording
    // hardcoded "the file and git/gh tools you hold here" even when the only
    // tool present is a non-executing shell one — canExecute and
    // canWriteToDrive are both false here, and so are hasFileTools/
    // hasGitPathTools/hasGitCwdTools/hasGhTools, since spawn_shell alone is
    // what triggers hasSandboxComputeTools.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('file and git/gh tools');
    expect(result).not.toContain('readFile');
    expect(result).not.toContain('git_clone');
  });

  it('given read_shell alone (survives read-only filtering), does NOT claim file/git tools', () => {
    const result = buildSystemPrompt(true, undefined, true, ['read_page', 'read_shell']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('file and git/gh tools');
    expect(result).not.toContain('readFile');
    expect(result).not.toContain('git_clone');
  });

  it('given spawn_shell without send_shell (shell-only, no file tools), the persistence bullet does NOT claim file read/write', () => {
    // codex review, fresh evidence: the persistence bullet's non-git fallback
    // hardcoded "files you write are still there... read a file back" even
    // for a shell-only surface that can neither write nor read files.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'spawn_shell']);
    expect(result).toContain('/workspace');
    expect(result).not.toContain('files you write');
    expect(result).not.toContain('read a file back');
  });

  it('given a file tool (writeFile), the persistence bullet does claim file read/write', () => {
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'writeFile']);
    expect(result).toContain('files you write');
  });

  it('given the sandbox guidance, should cover the auth boundary, cwd, editFile, persistence, and key tools', () => {
    const result = buildSystemPrompt(false, undefined, true);
    // Auth boundary → dedicated tools
    expect(result).toContain('gh_pr_create');
    expect(result).toContain('git_*');
    // cwd / fresh-process
    expect(result).toContain('cwd');
    // editFile vs writeFile
    expect(result).toContain('editFile');
    // reuse-don't-recreate
    expect(result).toContain('gh_pr_list');
  });

  it('given the sandbox guidance, should include the Constraints{} block treating tool output as untrusted', () => {
    const result = buildSystemPrompt(false, undefined, true);
    expect(result).toContain('Constraints {');
    expect(result).toContain('tool output');
    expect(result).toContain('untrusted');
  });
});

describe('buildPersonalizationPrompt', () => {
  it('returns null when personalization is disabled', () => {
    const result = buildPersonalizationPrompt({ enabled: false });
    expect(result).toBeNull();
  });

  it('returns null when personalization is undefined', () => {
    const result = buildPersonalizationPrompt(undefined);
    expect(result).toBeNull();
  });

  it('returns null when enabled but all fields empty', () => {
    const result = buildPersonalizationPrompt({ enabled: true });
    expect(result).toBeNull();
  });

  it('includes bio section when present', () => {
    const result = buildPersonalizationPrompt({ enabled: true, bio: 'I am a developer' });
    expect(result).toContain('I am a developer');
  });

  it('includes writingStyle section when present', () => {
    const result = buildPersonalizationPrompt({ enabled: true, writingStyle: 'Concise and direct' });
    expect(result).toContain('Concise and direct');
  });

  it('includes rules section when present', () => {
    const result = buildPersonalizationPrompt({ enabled: true, rules: 'Always use TypeScript' });
    expect(result).toContain('Always use TypeScript');
  });
});

describe('getWelcomeMessage', () => {
  it('returns read-only message when isReadOnly is true', () => {
    const result = getWelcomeMessage(true);
    expect(result).toContain('read-only');
  });

  it('returns regular message when isReadOnly is false', () => {
    const result = getWelcomeMessage(false);
    expect(result).not.toContain('read-only');
  });

  it('includes Welcome prefix when isNew is true', () => {
    const result = getWelcomeMessage(false, true);
    expect(result).toContain('Welcome');
  });
});

describe('getErrorMessage', () => {
  it('includes the error string in the message', () => {
    const result = getErrorMessage('connection timeout');
    expect(result).toContain('connection timeout');
  });
});

describe('estimateSystemPromptTokens', () => {
  it('estimates ~1 token per 4 characters', () => {
    const prompt = 'a'.repeat(400);
    expect(estimateSystemPromptTokens(prompt)).toBe(100);
  });

  it('rounds up fractional tokens', () => {
    expect(estimateSystemPromptTokens('abc')).toBe(1);
  });
});

describe('buildNonCoreToolNamesPrompt', () => {
  it('returns empty string for empty tool list', () => {
    expect(buildNonCoreToolNamesPrompt([])).toBe('');
  });

  it('groups known tools into their category', () => {
    const result = buildNonCoreToolNamesPrompt(['list_calendar_events', 'create_calendar_event', 'send_channel_message']);
    expect(result).toContain('calendar: list_calendar_events, create_calendar_event');
    expect(result).toContain('channels: send_channel_message');
  });

  it('places unknown tool names in the "other" category', () => {
    const result = buildNonCoreToolNamesPrompt(['some_unknown_tool']);
    expect(result).toContain('other: some_unknown_tool');
  });

  it('includes the execute_tool usage instruction', () => {
    const result = buildNonCoreToolNamesPrompt(['get_activity']);
    expect(result).toContain('execute_tool');
    expect(result).toContain('tool_search');
  });

  it('groups permission tools into permissions category', () => {
    const result = buildNonCoreToolNamesPrompt(['list_drive_roles', 'create_drive_role', 'set_role_page_permissions']);
    expect(result).toContain('permissions: list_drive_roles, create_drive_role, set_role_page_permissions');
  });

  it('groups command tools into commands category', () => {
    const result = buildNonCoreToolNamesPrompt(['list_commands', 'create_command']);
    expect(result).toContain('commands: list_commands, create_command');
  });

  it('groups trigger tools into tasks and calendar categories', () => {
    const result = buildNonCoreToolNamesPrompt(['set_task_trigger', 'delete_calendar_trigger']);
    expect(result).toContain('tasks: set_task_trigger');
    expect(result).toContain('calendar: delete_calendar_trigger');
  });
});
