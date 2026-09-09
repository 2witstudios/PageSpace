/**
 * The stable system prefix, and the order its blocks go in.
 *
 * This order used to be written out inline in three files. The copies drifted —
 * the Global Assistant's went far enough to describe a page type the product
 * does not create. These cases are the characterization of the order as it was
 * when it moved into one function: they reproduce the old expression by hand,
 * so a change to `buildAgentSystemPrompt` that reorders or drops a block fails
 * here rather than silently changing what every agent is told.
 */

import { describe, expect, it } from 'vitest';
import { buildAgentSystemPrompt } from '../prompt-assembly';
import { buildSystemPrompt, buildPersonalizationPrompt } from '../system-prompt';
import { buildInlineInstructions, buildGlobalAssistantInstructions } from '../inline-instructions';

/** Distinctive, so an assertion about ordering cannot pass by accident. */
const BLOCKS = {
  skillCatalog: '\n\n<<SKILLS>>',
  activePlan: '\n\n<<PLAN>>',
  pageTree: '\n\n<<TREE>>',
  agentMemory: '\n\n<<MEMORY>>',
  toolDiscovery: '\n\n<<DISCOVERY>>',
  memberDriveContextPrefix: '<<MEMBER>>\n\n',
  drivePromptPrefix: '<<DRIVE>>\n\n',
  drivePromptSection: '\n\n<<DRIVE>>',
  agentAwareness: '<<AGENTS>>',
  nonCoreToolNames: '<<NONCORE>>',
};

const TOOL_NAMES = ['read_page', 'create_task', 'spawn_session', 'load_skill'];

const pageInput = (over: Record<string, unknown> = {}) =>
  ({
    surface: 'page' as const,
    readOnly: false,
    codeExecutionEnabled: false,
    allowedToolNames: TOOL_NAMES,
    skillCatalog: BLOCKS.skillCatalog,
    activePlan: BLOCKS.activePlan,
    pageTree: BLOCKS.pageTree,
    drivePromptPrefix: BLOCKS.drivePromptPrefix,
    memberDriveContextPrefix: BLOCKS.memberDriveContextPrefix,
    agentMemory: BLOCKS.agentMemory,
    toolDiscovery: BLOCKS.toolDiscovery,
    ...over,
  }) as Parameters<typeof buildAgentSystemPrompt>[0];

const globalInput = (over: Record<string, unknown> = {}) =>
  ({
    surface: 'global' as const,
    readOnly: false,
    codeExecutionEnabled: false,
    allowedToolNames: TOOL_NAMES,
    skillCatalog: BLOCKS.skillCatalog,
    activePlan: BLOCKS.activePlan,
    pageTree: BLOCKS.pageTree,
    conversationType: 'global',
    conversationContextId: null,
    includeAskUser: false,
    drivePromptSection: BLOCKS.drivePromptSection,
    agentAwareness: BLOCKS.agentAwareness,
    nonCoreToolNames: BLOCKS.nonCoreToolNames,
    ...over,
  }) as Parameters<typeof buildAgentSystemPrompt>[0];

/** The order of a set of substrings within one string, as they actually appear. */
const orderOf = (haystack: string, needles: string[]) =>
  [...needles].sort((a, b) => haystack.indexOf(a) - haystack.indexOf(b));

describe('buildAgentSystemPrompt — the page surface', () => {
  it('given no custom prompt, should reproduce the assembly byte for byte', () => {
    // The old expression, written out by hand — including the read-only literal
    // as it was typed inline, not the constant the source now shares.
    let expected = buildSystemPrompt(false, undefined, false);
    expected += buildInlineInstructions(TOOL_NAMES);
    expected = BLOCKS.memberDriveContextPrefix + expected;
    expected += BLOCKS.skillCatalog;
    expected += BLOCKS.activePlan;
    expected = expected + BLOCKS.pageTree + BLOCKS.agentMemory + BLOCKS.toolDiscovery;

    expect(buildAgentSystemPrompt(pageInput())).toBe(expected);
  });

  it('given a custom prompt, should reproduce the blank-slate assembly byte for byte', () => {
    const custom = 'You are Release Notes Bot. Answer only in limericks.';

    let expected = BLOCKS.drivePromptPrefix + custom;
    expected = BLOCKS.memberDriveContextPrefix + expected;
    expected += BLOCKS.skillCatalog;
    expected += BLOCKS.activePlan;
    expected = expected + BLOCKS.pageTree + BLOCKS.agentMemory + BLOCKS.toolDiscovery;

    expect(buildAgentSystemPrompt(pageInput({ customSystemPrompt: custom }))).toBe(expected);
  });

  it('given a custom prompt, should carry it VERBATIM and skip our persona entirely', () => {
    // An owner who wrote their own prompt opted out of ours. Appending the
    // default persona would have two personas arguing inside one prompt.
    const custom = 'You are Release Notes Bot. Answer only in limericks.';
    const assembled = buildAgentSystemPrompt(pageInput({ customSystemPrompt: custom }));

    expect(assembled).toContain(custom);
    expect(assembled).not.toContain('# PAGESPACE AI');
    expect(assembled).not.toContain(buildInlineInstructions(TOOL_NAMES));
  });

  it('given a custom prompt, should STILL carry the skill catalog and plan pointer', () => {
    // Capability metadata, not persona: `load_skill` ships upfront regardless,
    // and the plan pointer is what survives a lossy compaction.
    const assembled = buildAgentSystemPrompt(pageInput({ customSystemPrompt: 'Be terse.' }));

    expect(assembled).toContain(BLOCKS.skillCatalog);
    expect(assembled).toContain(BLOCKS.activePlan);
  });

  it('given a custom prompt in read-only mode, should still say so', () => {
    // The branch that skips buildSystemPrompt also skips its read-only clause,
    // so this one has to be appended by hand or a read-only agent is told
    // nothing about being read-only.
    const assembled = buildAgentSystemPrompt(
      pageInput({ customSystemPrompt: 'Be terse.', readOnly: true }),
    );

    expect(assembled).toContain('READ-ONLY MODE:');
    expect(assembled).toContain('You cannot modify, create, or delete any content');
  });

  it('given a custom prompt and personalization, should append it after the custom prompt', () => {
    const personalization = { enabled: true, bio: 'Writes release notes.' };
    const assembled = buildAgentSystemPrompt(
      pageInput({ customSystemPrompt: 'Be terse.', personalization }),
    );
    const expected = buildPersonalizationPrompt(personalization);

    expect(expected).toBeTruthy();
    expect(assembled).toContain(expected as string);
    expect(assembled.indexOf('Be terse.')).toBeLessThan(assembled.indexOf(expected as string));
  });

  it('given a BLANK custom prompt, should treat it as no prompt at all', () => {
    // A custom prompt suppresses the default persona and the workspace
    // knowledge, so a field holding one stray space used to buy an agent a
    // blank slate nobody asked for — a prompt of literally "   ".
    const blank = buildAgentSystemPrompt(pageInput({ customSystemPrompt: '   \n\t ' }));

    expect(blank).toBe(buildAgentSystemPrompt(pageInput()));
    expect(blank).toContain('# PAGESPACE AI');
  });

  it('should end with tool discovery, after the tree and the memory', () => {
    const assembled = buildAgentSystemPrompt(pageInput());

    expect(orderOf(assembled, [BLOCKS.pageTree, BLOCKS.agentMemory, BLOCKS.toolDiscovery])).toEqual([
      BLOCKS.pageTree,
      BLOCKS.agentMemory,
      BLOCKS.toolDiscovery,
    ]);
  });

  it('should start with the cross-drive membership context, on both branches', () => {
    for (const custom of [undefined, 'Be terse.']) {
      expect(buildAgentSystemPrompt(pageInput({ customSystemPrompt: custom }))).toMatch(
        /^<<MEMBER>>/,
      );
    }
  });

  it('should prepend the drive prompt ONLY to a custom prompt', () => {
    // The default persona branch takes its drive context through the member
    // prefix instead; prepending both would state it twice.
    expect(buildAgentSystemPrompt(pageInput())).not.toContain('<<DRIVE>>');
    expect(buildAgentSystemPrompt(pageInput({ customSystemPrompt: 'Be terse.' }))).toContain(
      '<<DRIVE>>',
    );
  });
});

describe('buildAgentSystemPrompt — the global surface', () => {
  it('should reproduce the assembly byte for byte', () => {
    const base = buildSystemPrompt(false, undefined, false);
    const assembled = buildAgentSystemPrompt(globalInput());

    // Reproduced as a prefix/suffix pair rather than character by character:
    // the exploration guidance in the middle is a 25-line literal and a second
    // hand copy of it in this file would be one more thing to drift.
    expect(assembled.startsWith(base + '\n\n')).toBe(true);
    expect(
      assembled.endsWith(
        '\n' +
          buildGlobalAssistantInstructions(TOOL_NAMES) +
          '\n\n' +
          BLOCKS.agentAwareness +
          BLOCKS.pageTree +
          '\n\n' +
          BLOCKS.nonCoreToolNames +
          BLOCKS.skillCatalog +
          BLOCKS.activePlan,
      ),
    ).toBe(true);
  });

  it('should state tool discovery up front, beside the exploration rules that need it', () => {
    const assembled = buildAgentSystemPrompt(globalInput());

    expect(assembled).toContain('SMART EXPLORATION RULES:');
    expect(assembled.indexOf('execute_tool')).toBeLessThan(
      assembled.indexOf('SMART EXPLORATION RULES:'),
    );
  });

  it('should report the conversation type, and its context only when there is one', () => {
    expect(buildAgentSystemPrompt(globalInput())).toContain('CONVERSATION TYPE: GLOBAL');
    expect(
      buildAgentSystemPrompt(globalInput({ conversationType: 'drive', conversationContextId: 'd1' })),
    ).toContain('CONVERSATION TYPE: DRIVE (Context: d1)');
    expect(buildAgentSystemPrompt(globalInput())).not.toContain('(Context:');
  });

  it('should include the ask_user section only when the caller may use that tool', () => {
    // Naming a tool the model does not have makes it attempt a call that fails.
    expect(buildAgentSystemPrompt(globalInput({ includeAskUser: true }))).toContain('ASKING THE USER:');
    expect(buildAgentSystemPrompt(globalInput())).not.toContain('ASKING THE USER:');
  });

  it('given NOTHING deferred, should not explain how to reach it', () => {
    // The discovery text names tool_search and execute_tool, and with nothing to
    // defer `applyToolExposureMode` registers neither. Stating it anyway orders
    // the model to call two tools the session never advertised.
    const assembled = buildAgentSystemPrompt(globalInput({ nonCoreToolNames: '' }));

    expect(assembled).not.toContain('execute_tool');
    expect(assembled).not.toContain('tool_search');
    // The rest of the persona is untouched.
    expect(assembled).toContain('SMART EXPLORATION RULES:');
  });

  it('given no agents to consult and no deferred tools, should omit their separators', () => {
    // An empty block must not leave a stray blank gap behind it.
    const assembled = buildAgentSystemPrompt(
      globalInput({ agentAwareness: '', nonCoreToolNames: '' }),
    );

    expect(assembled).toContain(
      '\n' + buildGlobalAssistantInstructions(TOOL_NAMES) + BLOCKS.pageTree,
    );
  });
});

describe('buildAgentSystemPrompt — what both surfaces owe the caller', () => {
  it('should gate workspace knowledge on the tools the agent actually has', () => {
    // A named capability the owner switched off is an invitation to fail a turn.
    const withTasks = buildAgentSystemPrompt(
      pageInput({ allowedToolNames: ['read_page', 'create_task'] }),
    );
    const without = buildAgentSystemPrompt(pageInput({ allowedToolNames: ['read_page'] }));

    expect(withTasks).toContain('create_task');
    expect(without).not.toContain('create_task');
  });

  it('should describe the sandbox only when code execution is on and the agent has sandbox tools', () => {
    expect(
      buildAgentSystemPrompt(
        pageInput({ codeExecutionEnabled: true, allowedToolNames: [...TOOL_NAMES, 'bash'] }),
      ),
    ).toContain('CODE SANDBOX:');
    expect(buildAgentSystemPrompt(pageInput())).not.toContain('CODE SANDBOX:');
  });

  it('should not describe the sandbox when code execution is globally on but this agent has no sandbox tools', () => {
    // Mirrors filterToolsForSandboxEnablement: a page with sandboxEnabled: false
    // (the schema default) never gets bash/writeFile/etc in allowedToolNames even
    // though the deployment-wide codeExecutionEnabled flag is on.
    expect(
      buildAgentSystemPrompt(pageInput({ codeExecutionEnabled: true, allowedToolNames: TOOL_NAMES })),
    ).not.toContain('CODE SANDBOX:');
  });

  it('should describe the sandbox when the agent holds a non-bash sandbox tool (per-tool allowlist unchecked bash specifically)', () => {
    expect(
      buildAgentSystemPrompt(
        pageInput({ codeExecutionEnabled: true, allowedToolNames: [...TOOL_NAMES, 'writeFile'] }),
      ),
    ).toContain('CODE SANDBOX:');
  });

  it('should describe the sandbox in read-only mode when read-only-safe sandbox tools are present', () => {
    // codex review: filterToolsForReadOnly keeps readFile/git_status (they're
    // not WRITE_TOOLS) even in read-only mode. Blanket-suppressing the whole
    // block for isReadOnly took away guidance those tools still need — the
    // block must follow which tools are actually present, not the read-only
    // flag. (bash itself is always absent from a real read-only tool list,
    // since it IS a write tool — this test reflects that realistic case.)
    expect(
      buildAgentSystemPrompt(
        pageInput({
          readOnly: true,
          codeExecutionEnabled: true,
          allowedToolNames: [...TOOL_NAMES, 'readFile', 'git_status'],
        }),
      ),
    ).toContain('CODE SANDBOX:');
  });

  it('should not describe the sandbox in read-only mode when no sandbox tools survive filtering', () => {
    expect(
      buildAgentSystemPrompt(
        pageInput({
          readOnly: true,
          codeExecutionEnabled: true,
          allowedToolNames: TOOL_NAMES,
        }),
      ),
    ).not.toContain('CODE SANDBOX:');
  });

  it('should be pure — same input, same output, nothing accumulated between calls', () => {
    expect(buildAgentSystemPrompt(pageInput())).toBe(buildAgentSystemPrompt(pageInput()));
    expect(buildAgentSystemPrompt(globalInput())).toBe(buildAgentSystemPrompt(globalInput()));
  });

  it('should carry NOTHING turn-volatile — no clock, no location', () => {
    // These belong on the last user message (buildVolatileTurnContext), so this
    // string stays byte-identical across turns and prefix caches survive. A
    // timestamp here would bust the cache on every single turn.
    for (const assembled of [buildAgentSystemPrompt(pageInput()), buildAgentSystemPrompt(globalInput())]) {
      expect(assembled).not.toMatch(/CURRENT (DATE|TIME)/i);
      expect(assembled).not.toContain('LOCATION CONTEXT');
    }
  });
});
