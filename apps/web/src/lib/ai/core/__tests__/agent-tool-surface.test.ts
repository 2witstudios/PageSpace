/**
 * The stored-config → runtime-surface answer (issue #2460).
 *
 * The reported symptom was "enabledTools is ignored". It is not: the allowlist
 * is applied faithfully and the sandbox family is stripped DOWNSTREAM of it by
 * a switch the reporter could not see and had no tool-level way to set. These
 * tests pin the distinction, because getting it wrong sends whoever reads the
 * warning after the wrong fix.
 */
import { describe, it, expect } from 'vitest';
import {
  describeAgentToolSurface,
  blockedByGate,
  formatAgentToolSurfaceNotes,
  formatConfigSurfaceNotes,
  toolSurfaceEcho,
  RUNTIME_TOGGLE_TOOL_NAMES,
} from '../agent-tool-surface';
import { ALWAYS_UPFRONT_TOOLS } from '../../tools/tool-exposure';

const REGISTERED = [
  'read_page',
  'create_page',
  'trash_page',
  'regex_search',
  'bash',
  'readFile',
  'spawn_shell',
  'spawn_session',
  'git_clone',
];

describe('describeAgentToolSurface', () => {
  it('given sandbox tools configured while sandboxEnabled is off, should block them and name THAT gate', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'bash', 'readFile', 'spawn_shell', 'git_clone'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(surface.granted).toEqual(['read_page']);
    expect(blockedByGate(surface, 'sandbox_disabled')).toEqual([
      'bash',
      'readFile',
      'spawn_shell',
      'git_clone',
    ]);
  });

  it('given the same config with sandboxEnabled on, should grant every one of them', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'bash', 'readFile', 'spawn_shell', 'git_clone'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(surface.blocked).toEqual([]);
    expect(surface.granted).toEqual(['read_page', 'bash', 'readFile', 'spawn_shell', 'git_clone']);
  });

  it('given a name no registry offers, should block it as not_registered — enabling the sandbox would not bring it back', () => {
    const surface = describeAgentToolSurface({
      // `read_file` is what the reporter's worker actually tried to call, and
      // it is not the tool's name.
      enabledTools: ['read_file', 'bash'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(blockedByGate(surface, 'not_registered')).toEqual(['read_file']);
    expect(blockedByGate(surface, 'sandbox_disabled')).toEqual(['bash']);
  });

  it('given a deployment whose registry omits the sandbox family (CODE_EXECUTION_ENABLED off), should blame the DEPLOYMENT, not the switch', () => {
    // `buildPageSpaceTools` registers the compute families only behind the
    // global kill switch, so on such a deployment `sandboxEnabled: true` would
    // change nothing. Saying "turn the switch on" there sends the reader after
    // a fix that cannot work — and a spawn must WARN rather than refuse,
    // because no config the caller can write will help.
    const noSandboxRegistry = REGISTERED.filter(
      (name) => !['bash', 'readFile', 'spawn_shell', 'git_clone'].includes(name),
    );
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'bash'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: noSandboxRegistry,
    });

    expect(blockedByGate(surface, 'not_registered')).toEqual(['bash']);
    expect(blockedByGate(surface, 'sandbox_disabled')).toEqual([]);
    expect(formatAgentToolSurfaceNotes(surface).join(' ')).toContain('does not offer them');
  });

  it('given search exposure, should mark non-core granted tools deferred rather than lost', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'trash_page', 'bash'],
      sandboxEnabled: true,
      toolExposureMode: 'search',
      registeredToolNames: REGISTERED,
    });

    // read_page is core (sent upfront); the rest are reachable through
    // tool_search/execute_tool — present, not missing.
    expect(surface.granted).toEqual(['read_page', 'trash_page', 'bash']);
    expect(surface.deferred).toEqual(['trash_page', 'bash']);
    expect(surface.blocked).toEqual([]);
  });

  it('given an unconfigured agent, should block nothing — an empty allowlist asked for nothing', () => {
    const surface = describeAgentToolSurface({
      enabledTools: null,
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(surface.blocked).toEqual([]);
    expect(surface.granted).toEqual(['read_page', 'create_page', 'trash_page', 'regex_search']);
  });
});

describe('formatAgentToolSurfaceNotes', () => {
  it('given a config the gates honour verbatim, should say nothing', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'create_page'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(formatAgentToolSurfaceNotes(surface)).toEqual([]);
  });

  it('given sandbox tools blocked by the switch, should name the tools AND the fix', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['bash', 'spawn_shell'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    const notes = formatAgentToolSurfaceNotes(surface);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('bash, spawn_shell');
    expect(notes[0]).toContain('sandboxEnabled');
    expect(notes[0]).toContain('update_agent_config');
  });

  it('given a config that grants compute cleanly, should stay silent — the tier caveat is not a divergence', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['bash'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    // It is a real caveat, but it belongs to the config audience, not to every
    // spawn that consumes these notes.
    expect(formatAgentToolSurfaceNotes(surface)).toEqual([]);
  });
});

describe('formatConfigSurfaceNotes — the config audience hears one thing more', () => {
  it('given granted COMPUTE tools, should name the per-conversation gate this module cannot answer', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['bash'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(formatConfigSurfaceNotes(surface).join(' ')).toContain('payer tier');
  });

  it('given only the chat-side session family granted, should say nothing — sessions are free on every plan', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['spawn_session'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(formatConfigSurfaceNotes(surface).join(' ')).not.toContain('payer tier');
  });
});

/**
 * `web_search` and `generate_image` never pass through the allowlist at all:
 * `page-chat-turn.ts` lifts them out BEFORE it (step 2) and puts them back only
 * for a request whose composer toggle is on (steps 4/4b). A dispatched worker
 * turn carries no toggles, so a worker never gets them however its agent is
 * configured — reporting them as granted would be the same lie in a new place
 * (codex review, PR #2484).
 */
describe('the composer-toggle pair is neither granted nor blocked', () => {
  const WITH_TOGGLES = [...REGISTERED, 'web_search', 'generate_image'];

  it('given them in enabledTools, should report them as runtime-conditional, not effective', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'web_search', 'generate_image'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: WITH_TOGGLES,
    });

    expect(surface.granted).toEqual(['read_page']);
    expect(surface.conditional).toEqual(['web_search', 'generate_image']);
    // Not a blocked config: the same agent works fine in a browser chat with
    // the toggle on, so a spawn must not refuse over them.
    expect(surface.blocked).toEqual([]);
  });

  it('given an UNCONFIGURED agent, should keep them out of the effective set too', () => {
    const surface = describeAgentToolSurface({
      enabledTools: null,
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: WITH_TOGGLES,
    });

    expect(surface.granted).not.toContain('web_search');
    expect(surface.conditional).toEqual(['web_search', 'generate_image']);
  });

  it('should say out loud that a dispatched worker never receives them', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['web_search'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: WITH_TOGGLES,
    });

    const note = formatAgentToolSurfaceNotes(surface).join(' ');
    expect(note).toContain('composer toggle');
    expect(note).toContain('worker');
  });

  it('is exactly the set tool-exposure keeps upfront — drift in either must fail here, not silently', () => {
    // If a third tool is ever added to ALWAYS_UPFRONT_TOOLS, it is upfront for
    // a reason that may have nothing to do with a composer toggle. This pin
    // forces that decision to be made deliberately in both places.
    expect([...RUNTIME_TOGGLE_TOOL_NAMES].sort()).toEqual([...ALWAYS_UPFRONT_TOOLS].sort());
  });
});

describe('toolSurfaceEcho', () => {
  it('given a configured agent, reports the effective list', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['read_page', 'bash'],
      sandboxEnabled: false,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(toolSurfaceEcho(surface)).toMatchObject({
      effectiveTools: ['read_page'],
      effectiveToolsCount: 1,
      blockedTools: [{ tool: 'bash', gate: 'sandbox_disabled' }],
    });
  });

  it('given an UNRESTRICTED agent, reports null and a count — not a wall of ninety names', () => {
    // The block exists to show the DIVERGENCE from a stored list. An agent that
    // stored no list has none (`blockedTools` is empty by construction), so
    // listing everything it can call would be noise a model reads past on every
    // config write.
    const surface = describeAgentToolSurface({
      enabledTools: null,
      sandboxEnabled: true,
      toolExposureMode: 'search',
      registeredToolNames: REGISTERED,
    });

    const echo = toolSurfaceEcho(surface);
    expect(echo.effectiveTools).toBeNull();
    expect(echo.effectiveToolsCount).toBe(REGISTERED.length);
    expect(echo.blockedTools).toEqual([]);
    // NOT `[]` — in search mode this agent really does reach its non-core tools
    // through tool_search, and an empty array would claim otherwise.
    expect(echo.toolsReachedBySearch).toBeNull();
  });
});
