/**
 * Exhaustive read/write classification of the agent tool registry.
 *
 * `isApprovalGatedTool` (ask-mode approval cards) and `filterToolsForReadOnly`
 * are both DEFAULT-OPEN: a tool is gated/stripped only if it is in
 * `WRITE_TOOLS`. A write tool that nobody remembered to list therefore runs
 * with no card in `ask` mode and survives read-only mode. This suite closes
 * that by omission: every tool `buildPageSpaceTools()` can register must be
 * classified in exactly one of `WRITE_TOOLS` / `READ_TOOLS`, so adding a tool
 * without deciding which it is fails here.
 */
import { describe, it } from 'vitest';
import type { Tool } from 'ai';
import { BROWSER_TOOL_NAMES } from '@pagespace/browser-worker/browser-tool-name';
import { assert } from './riteway';
import { buildPageSpaceTools } from '../ai-tools';
import { READ_TOOLS, WRITE_TOOLS, filterToolsForReadOnly } from '../tool-filtering';
import { isApprovalGatedTool } from '../../approvals/approval-policy';

/**
 * The widest registry a deployment can produce: code execution ON, and the
 * browser factory returning every browser tool (the real one returns none
 * unless a substrate is configured, which a unit test cannot provide).
 */
const registeredToolNames = (): string[] => {
  const stub: Tool = buildPageSpaceTools({ codeExecutionEnabled: false }).read_page;
  const tools = buildPageSpaceTools({
    codeExecutionEnabled: true,
    browserToolsFactory: () => Object.fromEntries(BROWSER_TOOL_NAMES.map((name) => [name, stub])),
  });
  return Object.keys(tools).sort();
};

describe('tool read/write classification', () => {
  const registered = registeredToolNames();

  it('classifies every registered tool as read or write', () => {
    assert({
      given: 'every tool buildPageSpaceTools can register',
      should: 'find each one in WRITE_TOOLS or READ_TOOLS (unclassified tools listed here)',
      actual: registered.filter((name) => !WRITE_TOOLS.has(name) && !READ_TOOLS.has(name)),
      expected: [],
    });
  });

  it('never classifies a tool as both read and write', () => {
    assert({
      given: 'the two classification sets',
      should: 'be disjoint',
      actual: [...READ_TOOLS].filter((name) => WRITE_TOOLS.has(name)),
      expected: [],
    });
  });

  it('carries no stale names in either set', () => {
    const known = new Set(registered);
    assert({
      given: 'WRITE_TOOLS and READ_TOOLS',
      should: 'name only tools the registry actually registers',
      actual: [...WRITE_TOOLS, ...READ_TOOLS].filter((name) => !known.has(name)),
      expected: [],
    });
  });

  it('gates every write tool in ask mode and none of the read tools', () => {
    assert({
      given: 'every registered tool',
      should: 'be approval-gated exactly when it is a write tool',
      actual: registered.filter((name) => isApprovalGatedTool(name) !== WRITE_TOOLS.has(name)),
      expected: [],
    });
  });

  it('strips exactly the write tools in read-only mode', () => {
    const tools = Object.fromEntries(registered.map((name) => [name, name]));
    assert({
      given: 'the full registry in read-only mode',
      should: 'keep exactly the READ_TOOLS',
      actual: Object.keys(filterToolsForReadOnly(tools, true)).sort(),
      expected: registered.filter((name) => READ_TOOLS.has(name)),
    });
  });

  it('gates the sharing/form/status writes that previously skipped the card', () => {
    const names = [
      'share_event_with_drive',
      'unshare_event_from_drive',
      'provision_form_target',
      'update_form_target_status',
      'create_task_status',
    ];
    assert({
      given: 'tools that change visibility, public form access or task-list config',
      should: 'all be approval-gated',
      actual: names.filter((name) => !isApprovalGatedTool(name)),
      expected: [],
    });
  });
});
