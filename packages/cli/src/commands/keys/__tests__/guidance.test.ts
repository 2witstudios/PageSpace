import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST } from '../../../config/resolve.js';
import { renderAgentWiringGuidance, SHOW_TOKEN_PROMPT, WIZARD_INTRO_HINT } from '../guidance.js';

function embeddedJson(lines: readonly string[]): unknown {
  const start = lines.indexOf('{');
  const end = lines.lastIndexOf('}');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

describe('renderAgentWiringGuidance', () => {
  it('embeds a valid, ready-to-paste MCP config JSON block referencing the profile', () => {
    const lines = renderAgentWiringGuidance({ profileName: 'ci-bot', host: DEFAULT_HOST });
    expect(embeddedJson(lines)).toEqual({
      mcpServers: {
        pagespace: {
          command: 'pagespace',
          args: ['mcp'],
          env: { PAGESPACE_PROFILE: 'ci-bot' },
        },
      },
    });
  });

  it('adds PAGESPACE_API_URL to the env block only for a non-default host', () => {
    const lines = renderAgentWiringGuidance({ profileName: 'ci-bot', host: 'https://dev.example.com' });
    const config = embeddedJson(lines) as { mcpServers: { pagespace: { env: Record<string, string> } } };
    expect(config.mcpServers.pagespace.env).toEqual({
      PAGESPACE_PROFILE: 'ci-bot',
      PAGESPACE_API_URL: 'https://dev.example.com',
    });
  });

  it('explains what a profile is and names the raw-token env var alternative for .env/CI', () => {
    const text = renderAgentWiringGuidance({ profileName: 'ci-bot', host: DEFAULT_HOST }).join('\n');
    expect(text).toMatch(/keychain/i);
    expect(text).toContain('PAGESPACE_TOKEN=');
    expect(text).toMatch(/shown once/i);
  });
});

describe('wizard copy constants', () => {
  it('the intro hint explains keys and profiles in one breath', () => {
    expect(WIZARD_INTRO_HINT).toMatch(/scoped credentials/i);
    expect(WIZARD_INTRO_HINT).toMatch(/profile/i);
  });

  it('the show-token prompt warns it is shown once', () => {
    expect(SHOW_TOKEN_PROMPT).toMatch(/won't be shown again/i);
  });
});
