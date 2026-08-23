import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST } from '../../../config/resolve.js';
import { keysDescribeHint, renderAgentWiringGuidance, SHOW_TOKEN_PROMPT, WIZARD_INTRO_HINT } from '../guidance.js';

function embeddedJson(lines: readonly string[]): unknown {
  const start = lines.indexOf('{');
  const end = lines.lastIndexOf('}');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

describe('renderAgentWiringGuidance', () => {
  it('embeds a valid, ready-to-paste MCP config JSON block referencing the key by name', () => {
    const lines = renderAgentWiringGuidance({ keyName: 'ci-bot', host: DEFAULT_HOST });
    expect(embeddedJson(lines)).toEqual({
      mcpServers: {
        pagespace: {
          // `npx`, not `pagespace`: the mint may have run via `npx -p
          // @pagespace/cli`, and GUI MCP clients don't inherit the shell PATH,
          // so a bare `pagespace` command is the form most likely to fail.
          // `-p` is required — two bins here, neither named `cli`.
          command: 'npx',
          args: ['-y', '-p', '@pagespace/cli', 'pagespace-mcp'],
          env: { PAGESPACE_KEY: 'ci-bot' },
        },
      },
    });
  });

  it('offers the global-install shorthand as a follow-up line rather than as the pasted config', () => {
    const lines = renderAgentWiringGuidance({ keyName: 'ci-bot', host: DEFAULT_HOST });
    const afterConfig = lines.slice(lines.lastIndexOf('}') + 1).join('\n');
    expect(afterConfig).toContain('"command": "pagespace", "args": ["mcp"]');
    expect(afterConfig).toMatch(/globally/i);
  });

  it('adds PAGESPACE_API_URL to the env block only for a non-default host', () => {
    const lines = renderAgentWiringGuidance({ keyName: 'ci-bot', host: 'https://dev.example.com' });
    const config = embeddedJson(lines) as { mcpServers: { pagespace: { env: Record<string, string> } } };
    expect(config.mcpServers.pagespace.env).toEqual({
      PAGESPACE_KEY: 'ci-bot',
      PAGESPACE_API_URL: 'https://dev.example.com',
    });
  });

  it('explains what a key is and names the raw-token env var alternative for .env/CI', () => {
    const text = renderAgentWiringGuidance({ keyName: 'ci-bot', host: DEFAULT_HOST }).join('\n');
    expect(text).toMatch(/keychain/i);
    expect(text).toContain('PAGESPACE_TOKEN=');
    expect(text).toMatch(/shown once/i);
  });
});

describe('wizard copy constants', () => {
  it('the intro hint explains keys as locally named credentials, with no "profile" vocabulary left', () => {
    expect(WIZARD_INTRO_HINT).toMatch(/scoped credentials/i);
    expect(WIZARD_INTRO_HINT).toMatch(/named credential/i);
    expect(WIZARD_INTRO_HINT).not.toMatch(/profile/i);
  });

  it('the show-token prompt warns it is shown once', () => {
    expect(SHOW_TOKEN_PROMPT).toMatch(/won't be shown again/i);
  });
});

/**
 * `keys describe` is the one `keys` verb that is NOT auth-exempt, so it faces
 * `run.ts`'s explicit-credential gate. With a personal login and no active key
 * — the state a user is in immediately after `keys create` — a bare
 * `pagespace keys describe` is refused outright, which made the hint printed by
 * every mint name a command the reader could not run.
 */
describe('keysDescribeHint', () => {
  it('names the key that was just minted, so the printed command is runnable', () => {
    expect(keysDescribeHint('lead-gen')).toContain('pagespace keys describe --key=lead-gen');
  });

  // Key names are close to free-form (`resolveNewKeyName` refuses only the
  // reserved "default"), so an unquoted name with a space printed a command the
  // shell would mis-split: `--key` took `lead`, and `gen` became a stray
  // positional the parser rejects. A hint that cannot be pasted is worse than
  // no hint, because the reader cannot tell it from one that can.
  // Quoting alone is not enough: a name starting with `-` survives
  // quote-stripping as the argv word `-prod`, and `parseArgv` rejects a
  // space-separated flag value beginning with `-`. The equals-joined form is
  // what `parse.ts` documents for exactly that ambiguity, so the hint uses it
  // unconditionally — a plain name is unquoted, but still `--key=`.
  it.each([
    ['lead gen', "--key='lead gen'"],
    ["o'brien", "--key='o'\\''brien'"],
    ['a$HOME', "--key='a$HOME'"],
    ['~x', "--key='~x'"],
    ['plain-name_1', '--key=plain-name_1'],
    ['-prod', '--key=-prod'],
    ['--json', '--key=--json'],
  ])('prints %j as a word a shell hands back intact', (keyName, expected) => {
    expect(keysDescribeHint(keyName)).toContain(expected);
  });

  it('is printed exactly once per mint, by the wiring guidance', () => {
    const output = renderAgentWiringGuidance({ keyName: 'lead-gen', host: DEFAULT_HOST }).join('\n');
    const occurrences = output.split('pagespace keys describe').length - 1;
    expect(occurrences).toBe(1);
    expect(output).toContain('--key=lead-gen');
  });
});
