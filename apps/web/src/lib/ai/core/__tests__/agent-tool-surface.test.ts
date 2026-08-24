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
} from '../agent-tool-surface';

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

  it('given granted COMPUTE tools, should caveat the per-conversation tier gate this module cannot answer', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['bash'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(formatAgentToolSurfaceNotes(surface).join(' ')).toContain('payer tier');
  });

  it('given only the chat-side session family granted, should NOT invent a tier caveat — sessions are free on every plan', () => {
    const surface = describeAgentToolSurface({
      enabledTools: ['spawn_session'],
      sandboxEnabled: true,
      toolExposureMode: 'upfront',
      registeredToolNames: REGISTERED,
    });

    expect(formatAgentToolSurfaceNotes(surface).join(' ')).not.toContain('payer tier');
  });
});
