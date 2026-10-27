/**
 * The admin viewer renders itself as "the exact context window", so the one
 * thing it must never be is approximately right.
 *
 * It used to assemble its own prompt, and that copy had drifted: it left out
 * the Global Assistant's exploration guidance entirely, applied the capability
 * sections with no tool gating at all, and ordered the blocks in a way no route
 * used. It now calls `buildAgentSystemPrompt`, the same function the routes
 * call, and these cases pin the parts that were wrong.
 */

import { describe, expect, it } from 'vitest';
import { buildCompleteRequest } from '../complete-request-builder';
import { buildAgentSystemPrompt } from '../prompt-assembly';
import { buildBuiltinSkillCatalog } from '../skill-catalog';
import { buildNonCoreToolNamesPrompt } from '../system-prompt';
import { filterToolsForReadOnly } from '../tool-filtering';
import { CORE_TOOL_NAMES } from '../stub-tools';
import { pageSpaceTools } from '../ai-tools';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';

const dashboard = (isReadOnly = false) =>
  buildCompleteRequest({ contextType: 'dashboard', isReadOnly }).request.system;

describe('buildCompleteRequest — showing what is actually sent', () => {
  it('should include the Global Assistant guidance the old copy left out', () => {
    // The single largest thing the hand-rolled version was missing: an admin
    // reading it would not have seen the exploration rules at all.
    const system = dashboard();

    expect(system).toContain('You are the Global Assistant for PageSpace');
    expect(system).toContain('SMART EXPLORATION RULES:');
    expect(system).toContain('CONVERSATION TYPE: GLOBAL');
  });

  it('should be byte-identical to what the shared builder produces', () => {
    // Not "looks similar": the viewer's whole claim is exactness, so it is
    // asserted against the same call the routes make, with the same inputs.
    const allFilteredTools = filterToolsForReadOnly(pageSpaceTools, false);
    const allowedToolNames = Object.keys(allFilteredTools);
    const nonCoreToolNames = buildNonCoreToolNamesPrompt(
      allowedToolNames.filter((n) => !CORE_TOOL_NAMES.has(n)),
    );

    expect(dashboard()).toBe(
      buildAgentSystemPrompt({
        surface: 'global',
        readOnly: false,
        codeExecutionEnabled: isCodeExecutionEnabled(),
        allowedToolNames,
        skillCatalog: buildBuiltinSkillCatalog(allowedToolNames),
        activePlan: '',
        pageTree: '',
        conversationType: 'global',
        conversationContextId: null,
        includeAskUser: false,
        drivePromptSection: '',
        agentAwareness: '',
        nonCoreToolNames,
      }),
    );
  });

  it('should pass the available tool names through, not the include-everything sentinel', () => {
    // The old copy called the section builders with NO arguments, which is the
    // "no filtering context" sentinel. The sections vary with the tools on
    // hand, so the preview showed a set of capabilities that belonged to no
    // actual caller. Passing the real names changes the output — which is the
    // observable difference, and the direction is beside the point.
    const withRealNames = dashboard();
    const sentinel = buildAgentSystemPrompt({
      surface: 'global',
      readOnly: false,
      codeExecutionEnabled: isCodeExecutionEnabled(),
      allowedToolNames: [],
      skillCatalog: '',
      activePlan: '',
      pageTree: '',
      conversationType: 'global',
      conversationContextId: null,
      includeAskUser: false,
      drivePromptSection: '',
      agentAwareness: '',
      nonCoreToolNames: '',
    });

    expect(withRealNames).not.toBe(sentinel);
  });

  it('should say so when the preview is read-only', () => {
    expect(dashboard(true)).toContain('READ-ONLY MODE:');
    expect(dashboard(false)).not.toContain('READ-ONLY MODE:');
  });

  it('should preview the PAGE surface when the context is a page', () => {
    // The two surfaces are different assistants, and the viewer takes a
    // contextType precisely so an admin can see which one they are looking at.
    const page = buildCompleteRequest({
      contextType: 'page',
      locationContext: {
        currentPage: { id: 'p1', title: 'Notes', type: 'DOCUMENT', path: '/Notes' },
      },
    }).request.system;

    expect(page).not.toContain('You are the Global Assistant for PageSpace');
    expect(page).toContain('# PAGESPACE AI');
  });

  it('should still keep the volatile block off the system prompt', () => {
    // Production appends timestamp/location/mention to the last user message so
    // the system prefix stays cache-stable; the viewer mirrors that, and this
    // change must not have quietly pulled them forward.
    const { request } = buildCompleteRequest({ contextType: 'dashboard' });

    expect(request.system).not.toMatch(/CURRENT (DATE|TIME)/i);
    expect(request.messages[0].content).toMatch(/current date|current time/i);
  });
});
