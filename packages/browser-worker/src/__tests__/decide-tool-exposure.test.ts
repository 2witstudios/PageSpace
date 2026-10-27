import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { decideToolExposure, type DecideToolExposureOptions } from '../decide-tool-exposure.js';
import { BROWSER_TOOL_NAMES } from '../browser-tool-name.js';

const open: DecideToolExposureOptions = {
  substrateConfigured: true,
  codeExecutionEnabled: true,
  agent: { sandboxEnabled: true, enabledTools: null, readOnly: false },
  tierEligible: true,
};

describe('decideToolExposure', () => {
  it('exposes every browser tool when every gate is open', () => {
    assert({
      given: 'a configured substrate, code execution on, a sandbox-enabled agent without an allowlist, and an eligible tier',
      should: 'expose all six browser tools',
      actual: decideToolExposure(open),
      expected: BROWSER_TOOL_NAMES,
    });
  });

  it('exposes nothing when any hard gate is closed', () => {
    const closed: readonly DecideToolExposureOptions[] = [
      { ...open, substrateConfigured: false },
      { ...open, codeExecutionEnabled: false },
      { ...open, agent: { ...open.agent, sandboxEnabled: false } },
      { ...open, tierEligible: false },
    ];
    assert({
      given: 'no substrate, the code-execution kill switch, an agent with its sandbox off, and an ineligible tier',
      should: 'expose no browser tool in each case',
      actual: closed.map((options) => decideToolExposure(options)),
      expected: closed.map(() => []),
    });
  });

  it('honours the agent allowlist', () => {
    assert({
      given: 'an agent whose allowlist names read, navigate and an unrelated tool',
      should: 'expose only the browser tools it names, in canonical order',
      actual: decideToolExposure({ ...open, agent: { ...open.agent, enabledTools: ['browser_read', 'web_search', 'browser_navigate'] } }),
      expected: ['browser_navigate', 'browser_read'],
    });
  });

  it('gives a read-only agent the observing tools only', () => {
    assert({
      given: 'a read-only agent',
      should: 'expose read and screenshot, and nothing that navigates, clicks, types or opens tabs',
      actual: decideToolExposure({ ...open, agent: { ...open.agent, readOnly: true } }),
      expected: ['browser_read', 'browser_screenshot'],
    });
  });

  it('applies the allowlist and read-only together', () => {
    assert({
      given: 'a read-only agent whose allowlist names click and screenshot',
      should: 'expose screenshot only',
      actual: decideToolExposure({ ...open, agent: { sandboxEnabled: true, enabledTools: ['browser_click', 'browser_screenshot'], readOnly: true } }),
      expected: ['browser_screenshot'],
    });
  });
});
